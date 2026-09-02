/**
 * Worker belepesi pont (spec 6.3, 19.).
 *
 * Ket uzemmod:
 *  - `http`    : minden HTTP-alapu queue (alapertelmezes)
 *  - `browser` : KIZAROLAG a bongeszos discovery, alacsony konkurenciaval
 *  - `all`     : mindketto (fejlesztoi kornyezethez)
 *
 * Graceful shutdown: a fut jobok befejezodhetnek, a lockok felszabadulnak,
 * a bongeszo process bezar (spec 19.2, 32.5).
 */
import { Worker, type Job, type Processor } from 'bullmq';
import { closeDb, execute, initDb, query } from '@radovin/db';
import { closeBrowser } from '@radovin/crawler-core';
import { addMetricSink, configureLogger, logger } from '@radovin/observability';
import { loadWorkerConfig, type WorkerConfig } from './config.js';
import { closeWorkerQueues, workerRedis, type QueueName } from './lib/queue-client.js';
import { processDiscovery, processFetchUrl, processHealthCheck } from './processors/discovery.js';
import { processProposeProducers } from './processors/producer-propose.js';
import { processReextract } from './processors/reextract.js';
import {
  processClusterListing, processPromoteListing, processSearchAllShops, processUnmatchedResearch,
} from './processors/matching.js';
import {
  processAggregate, processAlertDispatch, processRefreshListing,
  processRefreshShop, processRetentionCleanup,
} from './processors/refresh.js';

type Handler = (job: Job, config: WorkerConfig) => Promise<unknown>;

/** Queue -> job nev -> processzor. */
const ROUTES: Record<string, Record<string, Handler>> = {
  'shop-discovery-http': {
    discovery: processDiscovery as Handler,
    'health-check': processHealthCheck as Handler,
  },
  'shop-discovery-browser': {
    discovery: processDiscovery as Handler,
    'health-check': processHealthCheck as Handler,
  },
  'listing-extract': {
    'fetch-single-url': processFetchUrl as Handler,
  },
  'known-listing-refresh': {
    'refresh-shop': processRefreshShop as Handler,
    'refresh-listing': processRefreshListing as Handler,
  },
  'candidate-generation': {
    'search-all-shops': processSearchAllShops as Handler,
    'cluster-listing': processClusterListing as Handler,
  },
  'product-ingest': {
    'promote-listing-to-variant': processPromoteListing as Handler,
    'propose-producers': processProposeProducers as Handler,
    // A jovahagyott boraszatok hatalyba leptetese a mar begyujtott neveken.
    'reextract-listings': processReextract as Handler,
  },
  'unmatched-research': {
    research: processUnmatchedResearch as Handler,
  },
  'aggregate-dashboard': {
    rebuild: processAggregate as Handler,
  },
  'alert-dispatch': {
    dispatch: processAlertDispatch as Handler,
  },
  'retention-cleanup': {
    cleanup: processRetentionCleanup as Handler,
  },
};

const HTTP_QUEUES: QueueName[] = [
  'shop-discovery-http', 'listing-extract', 'known-listing-refresh',
  'candidate-generation', 'match-evaluation', 'product-ingest',
  'unmatched-research', 'review-recheck', 'aggregate-dashboard',
  'alert-dispatch', 'retention-cleanup',
];
const BROWSER_QUEUES: QueueName[] = ['shop-discovery-browser'];

function buildProcessor(queueName: string, config: WorkerConfig): Processor {
  return async (job: Job) => {
    const started = Date.now();
    const handlers = ROUTES[queueName] ?? {};
    const handler = handlers[job.name];

    await execute(
      `UPDATE job_runs SET status = 'running', started_at = now(), attempt = $2
        WHERE external_job_id = $1 AND queue = $3`,
      [String(job.id), job.attemptsMade + 1, queueName],
    ).catch(() => undefined);

    if (!handler) {
      const message = `Nincs processzor a(z) "${queueName}/${job.name}" jobhoz.`;
      logger.error('worker.no_handler', { queue: queueName, jobName: job.name });
      await markJobFinished(job, queueName, 'failed', started, 'NO_HANDLER', message);
      throw new Error(message);
    }

    try {
      const result = await handler(job, config);
      await markJobFinished(job, queueName, 'succeeded', started, null, null, result);
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const isFinalAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
      await markJobFinished(
        job, queueName,
        isFinalAttempt ? 'dead_letter' : 'failed',
        started, 'JOB_EXCEPTION', message,
      );
      logger.error('worker.job_failed', {
        queue: queueName, jobName: job.name, jobId: String(job.id),
        attempt: job.attemptsMade + 1, final: isFinalAttempt, error: message,
      });
      throw err;
    }
  };
}

async function markJobFinished(
  job: Job, queue: string, status: string, started: number,
  errorCode: string | null, errorMessage: string | null, result?: unknown,
): Promise<void> {
  await execute(
    `UPDATE job_runs
        SET status = $2, finished_at = now(), duration_ms = $3,
            error_code = $4, error_message = $5, result = $6::jsonb
      WHERE external_job_id = $1 AND queue = $7`,
    [
      String(job.id), status, Date.now() - started, errorCode,
      errorMessage?.slice(0, 2000) ?? null,
      result === undefined ? null : JSON.stringify(result).slice(0, 20_000),
      queue,
    ],
  ).catch(() => undefined);
}

async function main(): Promise<void> {
  const config = loadWorkerConfig();
  process.env.TZ = process.env.TZ || 'Europe/Budapest';

  configureLogger({
    level: config.logLevel,
    pretty: config.logPretty,
    service: `worker-${config.mode}`,
  });

  logger.info('worker.starting', {
    mode: config.mode,
    httpConcurrency: config.httpConcurrency,
    browserConcurrency: config.browserConcurrency,
  });

  initDb({
    connectionString: config.databaseUrl,
    ssl: config.databaseSsl,
    max: config.databasePoolMax,
    applicationName: `radovin-worker-${config.mode}`,
  });
  await query('SELECT 1');
  logger.info('worker.db_connected');

  addMetricSink(({ metric, value, labels }) => {
    void query(
      'INSERT INTO metric_samples (metric, labels, value) VALUES ($1,$2::jsonb,$3)',
      [metric, JSON.stringify(labels), value],
    ).catch(() => undefined);
  });

  const connection = workerRedis(config.redisUrl);
  const workers: Worker[] = [];

  const queues: Array<{ name: QueueName; concurrency: number }> = [];
  if (config.mode === 'http' || config.mode === 'all') {
    for (const name of HTTP_QUEUES) {
      // A discovery draga: kevesebb parhuzamos futas (spec 19.5)
      const concurrency = name === 'shop-discovery-http' ? 2 : config.httpConcurrency;
      queues.push({ name, concurrency });
    }
  }
  if (config.mode === 'browser' || config.mode === 'all') {
    for (const name of BROWSER_QUEUES) {
      queues.push({ name, concurrency: config.browserConcurrency });
    }
  }

  for (const { name, concurrency } of queues) {
    const worker = new Worker(name, buildProcessor(name, config), {
      connection,
      concurrency,
      // A hosszu discovery futasok miatt megengedo lock megujitas
      lockDuration: 300_000,
      stalledInterval: 60_000,
      maxStalledCount: 2,
    });
    worker.on('failed', (job, err) => {
      logger.warn('worker.job_error', { queue: name, jobId: job?.id, error: err.message });
    });
    worker.on('error', (err) => {
      logger.error('worker.error', { queue: name, error: err.message });
    });
    workers.push(worker);
    logger.info('worker.queue_started', { queue: name, concurrency });
  }

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('worker.shutdown', { signal });
    try {
      // A fut jobok befejezhetik magukat, a lockok felszabadulnak
      await Promise.all(workers.map((w) => w.close()));
      await closeBrowser();
      await closeWorkerQueues();
      await closeDb();
      logger.info('worker.shutdown_complete');
    } catch (err) {
      logger.error('worker.shutdown_error', { error: err instanceof Error ? err.message : String(err) });
    }
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('unhandledRejection', (reason) => {
    logger.error('worker.unhandled_rejection', { reason: String(reason) });
  });
}

main().catch((err) => {
  process.stderr.write(`\nA worker nem indult el:\n${err instanceof Error ? err.message : String(err)}\n\n`);
  process.exit(1);
});
