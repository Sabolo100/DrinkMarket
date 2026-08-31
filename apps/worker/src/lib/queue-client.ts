/**
 * Queue kliens a workerek szamara (job -> job lancolas).
 */
import { Queue, type JobsOptions } from 'bullmq';
import { Redis } from 'ioredis';
import { execute } from '@radovin/db';
import { logger } from '@radovin/observability';
import type { WorkerConfig } from '../config.js';

export type QueueName =
  | 'product-ingest' | 'shop-discovery-http' | 'shop-discovery-browser'
  | 'listing-extract' | 'known-listing-refresh' | 'candidate-generation'
  | 'match-evaluation' | 'unmatched-research' | 'review-recheck'
  | 'aggregate-dashboard' | 'alert-dispatch' | 'retention-cleanup';

let connection: Redis | null = null;
const queues = new Map<string, Queue>();

export function workerRedis(url: string): Redis {
  if (connection) return connection;
  const client = new Redis(url, {
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
    retryStrategy: (times: number) => Math.min(times * 500, 10_000),
  });
  client.on('error', (err: Error) => logger.error('redis.error', { error: err.message }));
  connection = client;
  return client;
}

export function workerQueue(config: WorkerConfig, name: QueueName): Queue {
  const existing = queues.get(name);
  if (existing) return existing;
  const queue = new Queue(name, { connection: workerRedis(config.redisUrl) });
  queues.set(name, queue);
  return queue;
}

export interface WorkerEnqueue {
  queue: QueueName;
  name: string;
  payload: Record<string, unknown>;
  idempotencyKey?: string;
  priority?: number;
  delayMs?: number;
  shopId?: string | null;
  crawlRunId?: string | null;
  correlationId?: string;
}

export async function enqueueFromWorker(config: WorkerConfig, opts: WorkerEnqueue): Promise<string | null> {
  const queue = workerQueue(config, opts.queue);
  // A BullMQ nem fogad el ketpontot a custom job ID-ban (Redis kulcs-elvalaszto).
  const jobId = opts.idempotencyKey
    ? opts.idempotencyKey.replace(/[^A-Za-z0-9_.-]/g, '-').slice(0, 200)
    : undefined;

  const jobOptions: JobsOptions = {
    attempts: 3,
    backoff: { type: 'exponential', delay: 5000 },
    removeOnComplete: { age: 7 * 24 * 3600, count: 2000 },
    removeOnFail: { age: 30 * 24 * 3600, count: 5000 },
    ...(opts.priority !== undefined ? { priority: opts.priority } : {}),
    ...(opts.delayMs ? { delay: opts.delayMs } : {}),
    ...(jobId ? { jobId } : {}),
  };

  try {
    if (jobId) {
      const existing = await queue.getJob(jobId).catch(() => null);
      if (existing) {
        const state = await existing.getState().catch(() => 'unknown');
        if (state === 'waiting' || state === 'active' || state === 'delayed') return String(existing.id);
        await existing.remove().catch(() => undefined);
      }
    }
    const job = await queue.add(opts.name, { ...opts.payload, correlationId: opts.correlationId }, jobOptions);
    await execute(
      `INSERT INTO job_runs (queue, job_name, external_job_id, idempotency_key, status,
                             shop_id, crawl_run_id, payload, correlation_id)
       VALUES ($1,$2,$3,$4,'queued',$5,$6,$7::jsonb,$8) ON CONFLICT DO NOTHING`,
      [
        opts.queue, opts.name, String(job.id), opts.idempotencyKey ?? null,
        opts.shopId ?? null, opts.crawlRunId ?? null,
        JSON.stringify(opts.payload), opts.correlationId ?? null,
      ],
    ).catch(() => undefined);
    return String(job.id);
  } catch (err) {
    logger.warn('worker.enqueue_failed', {
      queue: opts.queue, name: opts.name,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

export async function closeWorkerQueues(): Promise<void> {
  for (const q of queues.values()) await q.close().catch(() => undefined);
  queues.clear();
  if (connection) {
    await connection.quit().catch(() => undefined);
    connection = null;
  }
}
