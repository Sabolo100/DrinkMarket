/**
 * Queue-k es job-beallitasok (spec 19.).
 *
 * Minden job: idempotencia-kulcs, explicit timeout, korlatozott retry,
 * exponencialis backoff, prioritas, dead-letter.
 */
import { Queue, type JobsOptions } from 'bullmq';
import { Redis } from 'ioredis';
import { execute } from '@radovin/db';
import { logger } from '@radovin/observability';

export const QUEUE_NAMES = [
  'product-ingest',
  'shop-discovery-http',
  'shop-discovery-browser',
  'listing-extract',
  'known-listing-refresh',
  'candidate-generation',
  'match-evaluation',
  'unmatched-research',
  'review-recheck',
  'aggregate-dashboard',
  'alert-dispatch',
  'retention-cleanup',
] as const;

export type QueueName = (typeof QUEUE_NAMES)[number];

/** Prioritasok (spec 19.3). Kisebb szam = elobb fut. */
export const JOB_PRIORITY: Record<string, number> = {
  'manual-search': 1,
  'known-listing-refresh': 2,
  'review-url-check': 3,
  'scheduled-price-refresh': 4,
  'shop-discovery': 5,
  'unmatched-research': 6,
  'retention-cleanup': 9,
};

let connection: Redis | null = null;
const queues = new Map<QueueName, Queue>();

export function redisConnection(url: string): Redis {
  if (connection) return connection;
  const client = new Redis(url, {
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
    retryStrategy: (times: number) => Math.min(times * 500, 10_000),
  });
  client.on('error', (err: Error) => logger.error('redis.error', { error: err.message }));
  client.on('connect', () => logger.info('redis.connected'));
  connection = client;
  return client;
}

export function getQueue(name: QueueName, redisUrl: string): Queue {
  const existing = queues.get(name);
  if (existing) return existing;
  const queue = new Queue(name, {
    connection: redisConnection(redisUrl),
    defaultJobOptions: defaultJobOptions(name),
  });
  queues.set(name, queue);
  return queue;
}

export function defaultJobOptions(name: QueueName): JobsOptions {
  const heavy = name === 'shop-discovery-http' || name === 'shop-discovery-browser';
  return {
    attempts: heavy ? 2 : 3,
    backoff: { type: 'exponential', delay: heavy ? 30_000 : 5_000 },
    removeOnComplete: { age: 7 * 24 * 3600, count: 2000 },
    removeOnFail: { age: 30 * 24 * 3600, count: 5000 },
  };
}

export interface EnqueueOptions {
  redisUrl: string;
  queue: QueueName;
  name: string;
  payload: Record<string, unknown>;
  /** Idempotencia-kulcs: azonos kulccsal nem indul ket parhuzamos job. */
  idempotencyKey?: string;
  priority?: number;
  delayMs?: number;
  shopId?: string | null;
  crawlRunId?: string | null;
  correlationId?: string;
}

/**
 * Job sorba allitasa + tartos job_runs rekord. A job_runs egyediseg
 * (idempotency_key) vedi a duplikalt feldolgozast (spec 19.2).
 */
/**
 * A beküldés eredménye. A `state` és a `waiting` azért kell, mert a
 * `shop-discovery-http` sor párhuzamossága szándékosan 2 (a felderítés drága):
 * egy beküldött job simán VÁRHAT. A felület enélkül azt írta ki, hogy
 * "elindult", és a felhasználó joggal hitte, hogy elveszett a kérése.
 */
export interface EnqueueResult {
  jobId: string;
  deduped: boolean;
  /** A job BullMQ-allapota a bekuldes utan: waiting | active | delayed | ... */
  state: string;
  /** Hany job var meg ebben a sorban (ezt is beleertve). */
  waiting: number;
}

export async function enqueue(opts: EnqueueOptions): Promise<EnqueueResult> {
  const queue = getQueue(opts.queue, opts.redisUrl);
  const jobOptions: JobsOptions = {
    ...defaultJobOptions(opts.queue),
    ...(opts.priority !== undefined ? { priority: opts.priority } : {}),
    ...(opts.delayMs ? { delay: opts.delayMs } : {}),
    ...(opts.idempotencyKey ? { jobId: sanitizeJobId(opts.idempotencyKey) } : {}),
  };

  // Ha van idempotencia-kulcs es mar fut/varakozik ilyen job, nem duplikalunk
  if (opts.idempotencyKey) {
    const existing = await queue.getJob(sanitizeJobId(opts.idempotencyKey)).catch(() => null);
    if (existing) {
      const state = await existing.getState().catch(() => 'unknown');
      if (state === 'waiting' || state === 'active' || state === 'delayed') {
        return {
          jobId: String(existing.id), deduped: true, state,
          waiting: await queue.getWaitingCount().catch(() => 0),
        };
      }
      await existing.remove().catch(() => undefined);
    }
  }

  const job = await queue.add(opts.name, {
    ...opts.payload,
    correlationId: opts.correlationId,
  }, jobOptions);

  await execute(
    `INSERT INTO job_runs
       (queue, job_name, external_job_id, idempotency_key, status, priority,
        max_attempts, shop_id, crawl_run_id, payload, correlation_id)
     VALUES ($1,$2,$3,$4,'queued',$5,$6,$7,$8,$9,$10)
     ON CONFLICT DO NOTHING`,
    [
      opts.queue, opts.name, String(job.id), opts.idempotencyKey ?? null,
      opts.priority ?? 100, jobOptions.attempts ?? 3,
      opts.shopId ?? null, opts.crawlRunId ?? null,
      JSON.stringify(opts.payload), opts.correlationId ?? null,
    ],
  ).catch((err) => {
    logger.warn('queue.job_run_insert_failed', { queue: opts.queue, error: String(err) });
  });

  return {
    jobId: String(job.id),
    deduped: false,
    state: await job.getState().catch(() => 'waiting'),
    waiting: await queue.getWaitingCount().catch(() => 0),
  };
}

/**
 * BullMQ job ID. A ketpontot KI KELL szurni: a BullMQ a Redis kulcsokban
 * elvalasztokent hasznalja, es a `:`-t tartalmazo egyedi azonositot
 * "Custom Id cannot contain :" hibaval visszautasitja.
 */
function sanitizeJobId(key: string): string {
  return key.replace(/[^A-Za-z0-9_.-]/g, '-').slice(0, 200);
}

export async function queueStats(redisUrl: string): Promise<Array<{
  queue: QueueName; waiting: number; active: number; delayed: number; failed: number; completed: number;
}>> {
  const out = [];
  for (const name of QUEUE_NAMES) {
    const q = getQueue(name, redisUrl);
    try {
      const counts = await q.getJobCounts('waiting', 'active', 'delayed', 'failed', 'completed');
      out.push({
        queue: name,
        waiting: counts['waiting'] ?? 0,
        active: counts['active'] ?? 0,
        delayed: counts['delayed'] ?? 0,
        failed: counts['failed'] ?? 0,
        completed: counts['completed'] ?? 0,
      });
    } catch {
      out.push({ queue: name, waiting: 0, active: 0, delayed: 0, failed: 0, completed: 0 });
    }
  }
  return out;
}

export async function closeQueues(): Promise<void> {
  for (const q of queues.values()) await q.close().catch(() => undefined);
  queues.clear();
  if (connection) {
    await connection.quit().catch(() => undefined);
    connection = null;
  }
}
