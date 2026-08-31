/**
 * API belepesi pont.
 * Coolify: a konteneres inditaskor automatikusan lefuttatja a migraciokat
 * (advisory lock alatt), majd elindul a HTTP szerver.
 */
import { closeDb, initDb, migrate, query } from '@radovin/db';
import { addMetricSink, configureLogger, logger } from '@radovin/observability';
import { loadConfig } from './config.js';
import { buildServer } from './server.js';
import { ensureBootstrapAdmin } from './lib/auth.js';
import { closeQueues } from './lib/queues.js';

async function main(): Promise<void> {
  const config = loadConfig();
  process.env.TZ = config.TZ;

  configureLogger({
    level: config.LOG_LEVEL,
    pretty: config.LOG_FORMAT === 'pretty',
    service: 'api',
  });

  logger.info('api.starting', {
    nodeEnv: config.NODE_ENV,
    port: config.API_PORT,
    appName: config.APP_NAME,
  });

  initDb({
    connectionString: config.DATABASE_URL,
    ssl: config.DATABASE_SSL,
    max: config.DATABASE_POOL_MAX,
    applicationName: 'radovin-api',
  });

  // Kapcsolat ellenorzese
  await query('SELECT 1');
  logger.info('api.db_connected');

  if (config.DB_AUTO_MIGRATE) {
    const result = await migrate();
    logger.info('api.migrations', {
      applied: result.applied.length,
      skipped: result.skipped.length,
      drift: result.drift.length,
      appliedIds: result.applied,
    });
    if (result.drift.length) {
      logger.warn('api.migration_drift', {
        ids: result.drift.map((d) => d.id),
        hint: 'Egy mar lefuttatott migracios fajl megvaltozott. Uj migraciot kell irni helyette.',
      });
    }
  }

  const bootstrap = await ensureBootstrapAdmin(
    config.BOOTSTRAP_ADMIN_EMAIL,
    config.BOOTSTRAP_ADMIN_PASSWORD,
  );
  if (bootstrap === 'created') {
    logger.info('api.bootstrap_admin_created', { email: config.BOOTSTRAP_ADMIN_EMAIL });
  } else if (bootstrap === 'skipped') {
    logger.warn('api.bootstrap_admin_skipped', {
      hint: 'Nincs felhasznalo es nincs BOOTSTRAP_ADMIN_EMAIL/PASSWORD. Allitsd be oket az elso bejelentkezeshez.',
    });
  }

  // Metrikak a metric_samples tablaba (spec 30.2)
  addMetricSink(({ metric, value, labels }) => {
    void query(
      'INSERT INTO metric_samples (metric, shop_id, labels, value) VALUES ($1,$2,$3,$4)',
      [metric, labels['shopId'] ?? null, JSON.stringify(labels), value],
    ).catch(() => undefined);
  });

  const app = await buildServer(config);
  await app.listen({ port: config.API_PORT, host: config.API_HOST });
  logger.info('api.listening', { port: config.API_PORT, host: config.API_HOST });

  const shutdown = async (signal: string): Promise<void> => {
    logger.info('api.shutdown', { signal });
    try {
      await app.close();
      await closeQueues();
      await closeDb();
    } catch (err) {
      logger.error('api.shutdown_error', { error: err instanceof Error ? err.message : String(err) });
    }
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('unhandledRejection', (reason) => {
    logger.error('api.unhandled_rejection', { reason: String(reason) });
  });
}

main().catch((err) => {
  // A konfiguracios hibat olvashato formaban irjuk ki, hogy Coolify logban lathato legyen
  process.stderr.write(`\nAz API nem indult el:\n${err instanceof Error ? err.message : String(err)}\n\n`);
  process.exit(1);
});
