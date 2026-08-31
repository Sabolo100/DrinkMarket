import pg from 'pg';
import { logger } from '@radovin/observability';

const { Pool, types } = pg;

// ── Típuskonverziók ─────────────────────────────────────────────────────────
// A bigint (int8) alapból stringként jön. Minden pénzérték egész HUF, ami
// biztonságosan belefér a JS number-be (< 2^53), ezért számmá alakítjuk.
types.setTypeParser(20, (v) => (v === null ? null : Number(v)));
// numeric (1700) -> number. A pontosság a mi tartományunkban (score, pct) elég.
types.setTypeParser(1700, (v) => (v === null ? null : Number(v)));

export type Pool = pg.Pool;
export type PoolClient = pg.PoolClient;
export type QueryResultRow = pg.QueryResultRow;

let pool: pg.Pool | null = null;

export interface DbConfig {
  connectionString: string;
  ssl?: boolean;
  max?: number;
  applicationName?: string;
}

export function createPool(config: DbConfig): pg.Pool {
  const p = new Pool({
    connectionString: config.connectionString,
    ssl: config.ssl ? { rejectUnauthorized: false } : undefined,
    max: config.max ?? 12,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    application_name: config.applicationName ?? 'radovin-pi',
    statement_timeout: 60_000,
  });
  p.on('error', (err) => {
    logger.error('db.pool.error', { error: err.message });
  });
  return p;
}

export function initDb(config: DbConfig): pg.Pool {
  if (pool) return pool;
  pool = createPool(config);
  return pool;
}

export function db(): pg.Pool {
  if (!pool) {
    throw new Error('Az adatbázis pool nincs inicializálva. Hívd meg az initDb()-t a boot során.');
  }
  return pool;
}

export async function closeDb(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

// ── Lekérdezés-segédek ──────────────────────────────────────────────────────

export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params: unknown[] = [],
): Promise<T[]> {
  const started = Date.now();
  try {
    const res = await db().query<T>(text, params as never[]);
    const ms = Date.now() - started;
    if (ms > 1000) {
      logger.warn('db.slow_query', { ms, sql: text.slice(0, 240) });
    }
    return res.rows;
  } catch (err) {
    logger.error('db.query_failed', {
      sql: text.slice(0, 400),
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}

export async function queryOne<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params: unknown[] = [],
): Promise<T | null> {
  const rows = await query<T>(text, params);
  return rows[0] ?? null;
}

export async function execute(text: string, params: unknown[] = []): Promise<number> {
  const res = await db().query(text, params as never[]);
  return res.rowCount ?? 0;
}

/** Tranzakció. Hiba esetén automatikus rollback. */
export async function transaction<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await db().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* a kapcsolat már halott */
    }
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Postgres advisory lock. A worker-oldali duplikált feldolgozás ellen
 * (spec 19.5). A lock a callback futásáig él.
 */
export async function withAdvisoryLock<T>(
  key: string,
  fn: () => Promise<T>,
  opts: { waitMs?: number } = {},
): Promise<T | null> {
  const lockId = hashLockKey(key);
  const client = await db().connect();
  try {
    const deadline = Date.now() + (opts.waitMs ?? 0);
    for (;;) {
      const res = await client.query<{ locked: boolean }>('SELECT pg_try_advisory_lock($1) AS locked', [lockId]);
      if (res.rows[0]?.locked) break;
      if (Date.now() >= deadline) return null;
      await new Promise((r) => setTimeout(r, 250));
    }
    try {
      return await fn();
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [lockId]);
    }
  } finally {
    client.release();
  }
}

/** Stabil 64 bites lock-azonosító stringből (FNV-1a alapú). */
export function hashLockKey(key: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < key.length; i++) {
    const c = key.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x85ebca6b) >>> 0;
  }
  // BigInt kombináció, előjeles 64 bites tartományba illesztve
  const combined = (BigInt(h1) << 32n) | BigInt(h2);
  const signed = combined >= 1n << 63n ? combined - (1n << 64n) : combined;
  return signed.toString();
}
