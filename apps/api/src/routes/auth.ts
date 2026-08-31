import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { UserRole } from '@radovin/contracts';
import { execute, query, queryOne } from '@radovin/db';
import { AppError } from '@radovin/observability';
import type { AppConfig } from '../config.js';
import {
  SESSION_COOKIE, createSession, generateInviteToken, hashPassword, isLocked,
  registerFailedLogin, requireRole, resolveSession, revokeAllSessions, revokeSession,
  sha256, verifyPassword,
} from '../lib/auth.js';
import { audit } from '../lib/context.js';
import { clientIp } from '../server.js';

const loginSchema = z.object({
  email: z.string().email('Ervenytelen e-mail cim.'),
  password: z.string().min(1, 'A jelszo kotelezo.'),
});

const inviteSchema = z.object({
  email: z.string().email(),
  displayName: z.string().min(2).max(120),
  role: z.enum(['viewer', 'reviewer', 'catalog_manager', 'source_manager', 'admin']),
});

const acceptInviteSchema = z.object({
  token: z.string().min(10),
  password: z.string().min(12, 'A jelszo legalabb 12 karakter legyen.'),
});

export async function authRoutes(app: FastifyInstance, config: AppConfig): Promise<void> {
  // ── Bejelentkezes ───────────────────────────────────────────────────────
  app.post('/auth/login', async (req, reply) => {
    const body = loginSchema.parse(req.body);

    if (await isLocked(body.email)) {
      throw new AppError('ACCOUNT_LOCKED', 'A fiok atmenetileg zarolva tul sok sikertelen probalkozas miatt.', 423);
    }

    const user = await queryOne<{
      id: string; email: string; display_name: string; role: UserRole;
      password_hash: string | null; status: string;
    }>(
      `SELECT id, email, display_name, role, password_hash, status
         FROM users WHERE email_normalized = lower(btrim($1))`,
      [body.email],
    );

    const valid = user ? await verifyPassword(body.password, user.password_hash) : false;

    if (!user || !valid || user.status !== 'active') {
      if (user) await registerFailedLogin(body.email);
      await audit({
        actorKind: 'system', action: 'auth.login_failed', entityType: 'user',
        entityId: user?.id ?? null, summary: `Sikertelen bejelentkezes: ${body.email}`,
        correlationId: req.correlationId,
      });
      // Egyseges hibauzenet: nem arulja el, letezik-e a fiok
      throw new AppError('INVALID_CREDENTIALS', 'Hibas e-mail cim vagy jelszo.', 401);
    }

    const session = await createSession(user.id, {
      ttlHours: config.SESSION_TTL_HOURS,
      userAgent: req.headers['user-agent'],
      ip: clientIp(req),
      secret: config.SESSION_SECRET,
    });

    reply.setCookie(SESSION_COOKIE, session.token, {
      httpOnly: true,
      secure: config.COOKIE_SECURE,
      sameSite: 'lax',
      path: '/',
      expires: session.expiresAt,
      ...(config.COOKIE_DOMAIN ? { domain: config.COOKIE_DOMAIN } : {}),
    });

    await audit({
      actorUserId: user.id, action: 'auth.login', entityType: 'user', entityId: user.id,
      summary: 'Sikeres bejelentkezes.', correlationId: req.correlationId,
    });

    return {
      user: { id: user.id, email: user.email, displayName: user.display_name, role: user.role },
      csrfToken: session.csrfToken,
      expiresAt: session.expiresAt.toISOString(),
    };
  });

  // ── Kijelentkezes ───────────────────────────────────────────────────────
  app.post('/auth/logout', async (req, reply) => {
    if (req.sessionId) {
      await revokeSession(req.sessionId);
      await audit({
        actorUserId: req.user?.id ?? null, action: 'auth.logout', entityType: 'user',
        entityId: req.user?.id ?? null, correlationId: req.correlationId,
      });
    }
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  // ── Aktualis felhasznalo ────────────────────────────────────────────────
  app.get('/auth/me', async (req) => {
    const session = await resolveSession(req.cookies[SESSION_COOKIE]);
    if (!session) throw new AppError('UNAUTHENTICATED', 'Nincs ervenyes munkamenet.', 401);
    return { user: session.user, csrfToken: session.csrfToken };
  });

  // ── Jelszovaltas ────────────────────────────────────────────────────────
  app.post('/auth/change-password', async (req) => {
    const user = req.user;
    if (!user) throw new AppError('UNAUTHENTICATED', 'Bejelentkezes szukseges.', 401);
    const body = z.object({
      currentPassword: z.string().min(1),
      newPassword: z.string().min(12, 'Az uj jelszo legalabb 12 karakter legyen.'),
    }).parse(req.body);

    const row = await queryOne<{ password_hash: string | null }>(
      'SELECT password_hash FROM users WHERE id = $1', [user.id],
    );
    if (!(await verifyPassword(body.currentPassword, row?.password_hash ?? null))) {
      throw new AppError('INVALID_CREDENTIALS', 'A jelenlegi jelszo hibas.', 401);
    }
    await execute('UPDATE users SET password_hash = $2 WHERE id = $1', [user.id, await hashPassword(body.newPassword)]);
    await revokeAllSessions(user.id);
    await audit({
      actorUserId: user.id, action: 'auth.password_changed', entityType: 'user', entityId: user.id,
      summary: 'Jelszovaltas, minden munkamenet ervenytelenitve.', correlationId: req.correlationId,
    });
    return { ok: true, message: 'A jelszo megvaltozott. Jelentkezz be ujra.' };
  });

  // ── Meghivas elfogadasa (nyilvanos regisztracio nincs, spec 4.2) ────────
  app.post('/auth/accept-invite', async (req) => {
    const body = acceptInviteSchema.parse(req.body);
    const user = await queryOne<{ id: string; email: string }>(
      `SELECT id, email FROM users
        WHERE invite_token_hash = $1 AND status = 'invited'
          AND (invite_expires_at IS NULL OR invite_expires_at > now())`,
      [sha256(body.token)],
    );
    if (!user) throw new AppError('INVALID_INVITE', 'Ervenytelen vagy lejart meghivo.', 400);
    await execute(
      `UPDATE users SET password_hash = $2, status = 'active',
              invite_token_hash = NULL, invite_expires_at = NULL
        WHERE id = $1`,
      [user.id, await hashPassword(body.password)],
    );
    await audit({
      actorUserId: user.id, action: 'auth.invite_accepted', entityType: 'user', entityId: user.id,
      correlationId: req.correlationId,
    });
    return { ok: true, message: 'A fiok aktivalva. Most mar bejelentkezhetsz.' };
  });

  // ── Felhasznalok (admin) ────────────────────────────────────────────────
  app.get('/users', async (req) => {
    requireRole(req.user, 'admin');
    const users = await query(
      `SELECT id, email, display_name, role, status, last_login_at, created_at,
              (invite_token_hash IS NOT NULL) AS invite_pending
         FROM users ORDER BY created_at DESC`,
    );
    return { items: users };
  });

  app.post('/users/invite', async (req) => {
    const actor = requireRole(req.user, 'admin');
    const body = inviteSchema.parse(req.body);
    const invite = generateInviteToken();

    const existing = await queryOne<{ id: string }>(
      'SELECT id FROM users WHERE email_normalized = lower(btrim($1))', [body.email],
    );
    if (existing) throw new AppError('USER_EXISTS', 'Ezzel az e-mail cimmel mar letezik felhasznalo.', 409);

    const created = await queryOne<{ id: string }>(
      `INSERT INTO users (email, display_name, role, status, invite_token_hash, invite_expires_at)
       VALUES ($1,$2,$3,'invited',$4, now() + interval '7 days')
       RETURNING id`,
      [body.email, body.displayName, body.role, invite.hash],
    );

    await audit({
      actorUserId: actor.id, action: 'user.invited', entityType: 'user', entityId: created!.id,
      summary: `Meghivo kuldve: ${body.email} (${body.role})`,
      after: { email: body.email, role: body.role }, correlationId: req.correlationId,
    });

    // A nyers token CSAK a valaszban jelenik meg egyszer, naploba nem kerul.
    return {
      id: created!.id,
      inviteToken: invite.token,
      inviteUrl: `${config.APP_BASE_URL}/meghivo?token=${invite.token}`,
      expiresInDays: 7,
      note: 'A meghivo linket biztonsagos csatornan tovabbitsd. A token tobbet nem kerdezheto le.',
    };
  });

  app.patch('/users/:id/role', async (req) => {
    const actor = requireRole(req.user, 'admin');
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = z.object({
      role: z.enum(['viewer', 'reviewer', 'catalog_manager', 'source_manager', 'admin']),
    }).parse(req.body);

    const before = await queryOne<{ role: UserRole }>('SELECT role FROM users WHERE id = $1', [id]);
    if (!before) throw new AppError('NOT_FOUND', 'A felhasznalo nem talalhato.', 404);
    if (id === actor.id && body.role !== 'admin') {
      throw new AppError('SELF_DEMOTION', 'A sajat admin jogosultsagod nem vonhato meg.', 400);
    }

    await execute('UPDATE users SET role = $2 WHERE id = $1', [id, body.role]);
    await audit({
      actorUserId: actor.id, action: 'user.role_changed', entityType: 'user', entityId: id,
      before, after: { role: body.role }, correlationId: req.correlationId,
    });
    return { ok: true };
  });

  app.patch('/users/:id/status', async (req) => {
    const actor = requireRole(req.user, 'admin');
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = z.object({ status: z.enum(['active', 'suspended']) }).parse(req.body);
    if (id === actor.id) throw new AppError('SELF_SUSPEND', 'A sajat fiokod nem fuggeszthetó fel.', 400);

    await execute('UPDATE users SET status = $2 WHERE id = $1', [id, body.status]);
    if (body.status === 'suspended') await revokeAllSessions(id);
    await audit({
      actorUserId: actor.id, action: 'user.status_changed', entityType: 'user', entityId: id,
      after: { status: body.status }, correlationId: req.correlationId,
    });
    return { ok: true };
  });
}
