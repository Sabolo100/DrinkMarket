/**
 * Adatbazis CLI: migracio, statusz, seed, reset.
 * Hasznalat: npm run db:migrate | db:status | db:seed | db:reset
 */
import { closeDb, initDb, query } from './pool.js';
import { appliedMigrations, loadMigrations, migrate } from './migrate.js';
import { configureLogger, logger } from '@radovin/observability';

function config() {
  const url = process.env['DATABASE_URL'];
  if (!url) {
    throw new Error('A DATABASE_URL kornyezeti valtozo kotelezo. Pelda: postgres://user:pass@host:5432/db');
  }
  return {
    connectionString: url,
    ssl: process.env['DATABASE_SSL'] === 'true',
    max: 4,
    applicationName: 'radovin-db-cli',
  };
}

async function main(): Promise<void> {
  configureLogger({ level: 'info', pretty: true, service: 'db-cli' });
  const command = process.argv[2] ?? 'status';
  initDb(config());

  switch (command) {
    case 'migrate': {
      const result = await migrate();
      logger.info('db.migrate.done', {
        applied: result.applied, skipped: result.skipped.length, drift: result.drift.length,
      });
      if (result.drift.length) {
        process.stderr.write(
          `\nFIGYELEM: ${result.drift.length} mar lefuttatott migracios fajl megvaltozott:\n` +
          result.drift.map((d) => `  - ${d.id}`).join('\n') +
          `\nUj migraciot kell irni helyettuk.\n\n`,
        );
      }
      break;
    }
    case 'status': {
      const [files, applied] = await Promise.all([loadMigrations(), appliedMigrations()]);
      const appliedIds = new Set(applied.map((a) => a.id));
      process.stdout.write('\nMigraciok:\n');
      for (const f of files) {
        const isApplied = appliedIds.has(f.id);
        const row = applied.find((a) => a.id === f.id);
        process.stdout.write(
          `  ${isApplied ? '[x]' : '[ ]'} ${f.id}` +
          (row ? `  (${new Date(row.applied_at).toISOString().slice(0, 19)}, ${row.duration_ms} ms)` : '') +
          (row && row.checksum !== f.checksum ? '  <-- MEGVALTOZOTT!' : '') +
          '\n',
        );
      }
      const tables = await query<{ count: number }>(
        `SELECT count(*)::int AS count FROM information_schema.tables
          WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`,
      );
      process.stdout.write(`\nTablak szama: ${tables[0]?.count ?? 0}\n\n`);
      break;
    }
    case 'seed': {
      // A referenciaadatok a 0008 migracioban vannak (idempotens).
      await migrate();
      const counts = await query<{ table_name: string; count: number }>(`
        SELECT 'product_categories' AS table_name, count(*)::int AS count FROM product_categories
        UNION ALL SELECT 'shops', count(*)::int FROM shops
        UNION ALL SELECT 'identity_terms', count(*)::int FROM identity_terms
        UNION ALL SELECT 'negative_aliases', count(*)::int FROM negative_aliases
        UNION ALL SELECT 'settings', count(*)::int FROM settings
        UNION ALL SELECT 'feature_flags', count(*)::int FROM feature_flags
        ORDER BY 1
      `);
      process.stdout.write('\nReferenciaadatok:\n');
      for (const c of counts) process.stdout.write(`  ${c.table_name.padEnd(22)} ${c.count}\n`);
      process.stdout.write('\n');
      break;
    }
    case 'reset': {
      if (process.env['NODE_ENV'] === 'production' && process.env['ALLOW_DB_RESET'] !== 'yes') {
        throw new Error('Produkcios kornyezetben a reset tiltott. ALLOW_DB_RESET=yes kell hozza.');
      }
      process.stdout.write('\nA public sema teljes ujraepitese...\n');
      await query('DROP SCHEMA public CASCADE');
      await query('CREATE SCHEMA public');
      const result = await migrate();
      process.stdout.write(`Kesz. ${result.applied.length} migracio lefutott.\n\n`);
      break;
    }
    default:
      process.stderr.write(`Ismeretlen parancs: ${command}\nElerheto: migrate | status | seed | reset\n`);
      process.exitCode = 1;
  }

  await closeDb();
}

main().catch(async (err) => {
  process.stderr.write(`\nHiba: ${err instanceof Error ? err.message : String(err)}\n\n`);
  await closeDb().catch(() => undefined);
  process.exit(1);
});
