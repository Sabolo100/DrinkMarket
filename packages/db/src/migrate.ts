import { readdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { logger } from '@radovin/observability';
import { db, hashLockKey } from './pool.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** A migrációk a package gyökerében lévő migrations/ mappában vannak. */
export function migrationsDir(): string {
  // dist/migrate.js -> ../migrations   |   src/migrate.ts -> ../migrations
  return path.resolve(HERE, '..', 'migrations');
}

export interface MigrationFile {
  id: string;
  filename: string;
  sql: string;
  checksum: string;
}

export interface AppliedMigration {
  id: string;
  filename: string;
  checksum: string;
  applied_at: Date;
  duration_ms: number;
}

const LOCK_KEY = hashLockKey('radovin:schema_migrations');

async function ensureMigrationTable(): Promise<void> {
  await db().query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id          text PRIMARY KEY,
      filename    text NOT NULL,
      checksum    text NOT NULL,
      applied_at  timestamptz NOT NULL DEFAULT now(),
      duration_ms integer NOT NULL DEFAULT 0
    )
  `);
}

export async function loadMigrations(): Promise<MigrationFile[]> {
  const dir = migrationsDir();
  const entries = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  const out: MigrationFile[] = [];
  for (const filename of entries) {
    const sql = await readFile(path.join(dir, filename), 'utf8');
    const id = filename.replace(/\.sql$/, '');
    out.push({
      id,
      filename,
      sql,
      checksum: createHash('sha256').update(sql.replace(/\r\n/g, '\n')).digest('hex').slice(0, 32),
    });
  }
  return out;
}

export async function appliedMigrations(): Promise<AppliedMigration[]> {
  await ensureMigrationTable();
  const res = await db().query<AppliedMigration>(
    'SELECT id, filename, checksum, applied_at, duration_ms FROM schema_migrations ORDER BY id',
  );
  return res.rows;
}

export interface MigrateResult {
  applied: string[];
  skipped: string[];
  drift: Array<{ id: string; expected: string; actual: string }>;
}

/**
 * Idempotens migráció. Advisory lock alatt fut, így több API/worker példány
 * egyszerre indulva sem ütközik (Coolify többkonténeres deploy).
 */
export async function migrate(opts: { dryRun?: boolean } = {}): Promise<MigrateResult> {
  const client = await db().connect();
  const result: MigrateResult = { applied: [], skipped: [], drift: [] };
  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id          text PRIMARY KEY,
        filename    text NOT NULL,
        checksum    text NOT NULL,
        applied_at  timestamptz NOT NULL DEFAULT now(),
        duration_ms integer NOT NULL DEFAULT 0
      )
    `);

    const files = await loadMigrations();
    const applied = await client.query<{ id: string; checksum: string }>(
      'SELECT id, checksum FROM schema_migrations',
    );
    const appliedMap = new Map(applied.rows.map((r) => [r.id, r.checksum]));

    for (const file of files) {
      const existing = appliedMap.get(file.id);
      if (existing) {
        if (existing !== file.checksum) {
          result.drift.push({ id: file.id, expected: existing, actual: file.checksum });
          logger.warn('db.migration.checksum_drift', {
            id: file.id,
            hint: 'Egy már lefuttatott migrációs fájl megváltozott. Új migrációt kell írni helyette.',
          });
        }
        result.skipped.push(file.id);
        continue;
      }
      if (opts.dryRun) {
        result.applied.push(file.id);
        continue;
      }

      const started = Date.now();
      logger.info('db.migration.applying', { id: file.id });
      try {
        await client.query('BEGIN');
        await client.query(file.sql);
        await client.query(
          'INSERT INTO schema_migrations (id, filename, checksum, duration_ms) VALUES ($1,$2,$3,$4)',
          [file.id, file.filename, file.checksum, Date.now() - started],
        );
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        logger.error('db.migration.failed', {
          id: file.id,
          error: err instanceof Error ? err.message : String(err),
        });
        throw err;
      }
      result.applied.push(file.id);
      logger.info('db.migration.applied', { id: file.id, ms: Date.now() - started });
    }
    return result;
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => undefined);
    client.release();
  }
}
