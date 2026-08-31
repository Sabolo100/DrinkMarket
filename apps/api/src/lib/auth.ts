/**
 * Szerveroldali hitelesites es jogosultsagkezeles (spec 4.2, 29.1).
 *
 * - Jelszo scrypt-tel hash-elve (natív fuggoseg nelkul, node:crypto).
 * - Session token SHA-256 hash-kent tarolva; a nyers token csak a cookie-ban.
 * - HttpOnly + Secure + SameSite=Lax cookie.
 * - CSRF token minden modosito keresnel kotelezo.
 * - Kliensoldali vagy repoban tarolt credential TILOS.
 */
import { randomBytes, scrypt as scryptCb, timingSafeEqual, createHash, createHmac } from 'node:crypto';
import { promisify } from 'node:util';
import type { SessionUser, UserRole } from '@radovin/contracts';
import { ROLE_RANK } from '@radovin/contracts';
import { execute, queryOne, query } from '@radovin/db';
import { AppError } from '@radovin/observability';

const scrypt = promisify(scryptCb) as (
  password: string | Buffer, salt: string | Buffer, keylen: number, options?: Record<string, number>,
) => Promise<Buffer>;

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LEN = 64;

export const SESSION_COOKIE = 'rpi_session';
export const CSRF_HEADER = 'x-csrf-token';

export async function hashPassword(password: string): Promise<string> {
  if (password.length < 12) {
    throw new AppError('WEAK_PASSWORD', 'A jelszo legalabb 12 karakter legyen.', 400);
  }
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt, KEY_LEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
  return ['scrypt', SCRYPT_N, SCRYPT_R, SCRYPT_P, salt.toString('base64'), hash.toString('base64')].join('$');
}

export async function verifyPassword(password: string, stored: string | null): Promise<boolean> {
  if (!stored) return false;
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, nStr, rStr, pStr, saltB64, hashB64] = parts;
  const salt = Buffer.from(saltB64 ?? '', 'base64');
  const expected = Buffer.from(hashB64 ?? '', 'base64');
  const derived = await scrypt(password, salt, expected.length, {
    N: Number.parseInt(nStr ?? '', 10) || SCRYPT_N,
    r: Number.parseInt(rStr ?? '', 10) || SCRYPT_R,
    p: Number.parseInt(pStr ?? '', 10) || SCRYPT_P,
  });
  if (derived.length !== expected.length) return false;
  return timingSafeEqual(derived, expected);
}

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function hashIp(ip: string, secret: string): string {
  return createHmac('sha256', secret).update(ip).digest('hex').slice(0, 32);
}

export interface CreatedSession {
  token: string;
  csrfToken: string;
  expiresAt: Date;
  sessionId: string;
}

export async function createSession(
  userId: string,
  opts: { ttlHours: number; userAgent?: string; ip?: string; secret: string },
): Promise<CreatedSession> {
  const token = randomBytes(32).toString('base64url');
  const csrfToken = randomBytes(24).toString('base64url');
  const expiresAt = new Date(Date.now() + opts.ttlHours * 3_600_000);
  const row = await queryOne<{ id: string }>(
    `INSERT INTO sessions (user_id, token_hash, csrf_token, user_agent, ip_hash, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [
      userId, sha256(token), csrfToken,
      opts.userAgent?.slice(0, 400) ?? null,
      opts.ip ? hashIp(opts.ip, opts.secret) : null,
      expiresAt,
    ],
  );
  await execute('UPDATE users SET last_login_at = now(), failed_logins = 0, locked_until = NULL WHERE id = $1', [userId]);
  return { token, csrfToken, expiresAt, sessionId: row!.id };
}

export interface AuthenticatedSession {
  user: SessionUser;
  sessionId: string;
  csrfToken: string;
}

export async function resolveSession(token: string | undefined): Promise<AuthenticatedSession | null> {
  if (!token) return null;
  const row = await queryOne<{
    session_id: string; csrf_token: string; user_id: string;
    email: string; display_name: string; role: UserRole; status: string;
  }>(
    `SELECT s.id AS session_id, s.csrf_token, u.id AS user_id, u.email, u.display_name, u.role, u.status
       FROM sessions s
       JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = $1
        AND s.revoked_at IS NULL
        AND s.expires_at > now()`,
    [sha256(token)],
  );
  if (!row || row.status !== 'active') return null;
  // Nem minden kérésnél irunk - eleg 5 percenkent frissiteni a last_seen-t
  void execute(
    `UPDATE sessions SET last_seen_at = now()
      WHERE id = $1 AND last_seen_at < now() - interval '5 minutes'`,
    [row.session_id],
  ).catch(() => undefined);

  return {
    sessionId: row.session_id,
    csrfToken: row.csrf_token,
    user: { id: row.user_id, email: row.email, displayName: row.display_name, role: row.role },
  };
}

export async function revokeSession(sessionId: string): Promise<void> {
  await execute('UPDATE sessions SET revoked_at = now() WHERE id = $1', [sessionId]);
}

export async function revokeAllSessions(userId: string): Promise<void> {
  await execute('UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [userId]);
}

export async function purgeExpiredSessions(): Promise<number> {
  return execute(`DELETE FROM sessions WHERE expires_at < now() - interval '7 days'`);
}

// ── Brute force vedelem ─────────────────────────────────────────────────────

const MAX_FAILED = 8;
const LOCK_MINUTES = 15;

export async function registerFailedLogin(email: string): Promise<void> {
  await execute(
    `UPDATE users
        SET failed_logins = failed_logins + 1,
            locked_until = CASE WHEN failed_logins + 1 >= $2
                                THEN now() + ($3 || ' minutes')::interval
                                ELSE locked_until END
      WHERE email_normalized = lower(btrim($1))`,
    [email, MAX_FAILED, String(LOCK_MINUTES)],
  );
}

export async function isLocked(email: string): Promise<boolean> {
  const row = await queryOne<{ locked: boolean }>(
    `SELECT (locked_until IS NOT NULL AND locked_until > now()) AS locked
       FROM users WHERE email_normalized = lower(btrim($1))`,
    [email],
  );
  return row?.locked ?? false;
}

// ── Jogosultsag ─────────────────────────────────────────────────────────────

export function requireRole(user: SessionUser | null, ...allowed: UserRole[]): SessionUser {
  if (!user) throw new AppError('UNAUTHENTICATED', 'Bejelentkezes szukseges.', 401);
  if (user.role === 'admin') return user;
  if (!allowed.includes(user.role)) {
    throw new AppError(
      'FORBIDDEN',
      `Ehhez a muvelethez a kovetkezo szerepkorok egyike szukseges: ${allowed.join(', ')}.`,
      403,
    );
  }
  return user;
}

export function requireAtLeast(user: SessionUser | null, min: UserRole): SessionUser {
  if (!user) throw new AppError('UNAUTHENTICATED', 'Bejelentkezes szukseges.', 401);
  if (ROLE_RANK[user.role] < ROLE_RANK[min]) {
    throw new AppError('FORBIDDEN', `Legalabb "${min}" szerepkor szukseges.`, 403);
  }
  return user;
}

// ── Bootstrap admin ─────────────────────────────────────────────────────────

/**
 * Az elso admin letrehozasa kornyezeti valtozobol. Csak akkor fut le, ha meg
 * egyetlen felhasznalo sincs. A jelszo SOHA nem kerul naploba.
 */
export async function ensureBootstrapAdmin(email?: string, password?: string): Promise<'created' | 'skipped' | 'exists'> {
  const existing = await query<{ count: number }>('SELECT count(*)::int AS count FROM users');
  if ((existing[0]?.count ?? 0) > 0) return 'exists';
  if (!email || !password) return 'skipped';
  const hash = await hashPassword(password);
  await execute(
    `INSERT INTO users (email, display_name, password_hash, role, status)
     VALUES ($1, $2, $3, 'admin', 'active')
     ON CONFLICT DO NOTHING`,
    [email, 'Rendszergazda', hash],
  );
  return 'created';
}

export function generateInviteToken(): { token: string; hash: string } {
  const token = randomBytes(24).toString('base64url');
  return { token, hash: sha256(token) };
}
