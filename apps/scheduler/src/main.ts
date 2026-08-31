/**
 * Utemezo (spec 19.1, 19.3, 18.1).
 *
 * Nem vegez uzleti munkat - kizarolag jobokat hoz letre a megfelelo queue-ban,
 * a webshoponkent konfiguralt intervallumok szerint. Igy a worker leallasa
 * vagy ujraindulasa nem veszit el utemezest.
 */
import { Queue, type JobsOptions } from 'bullmq';
import { Redis } from 'ioredis';
import { z } from 'zod';
import { closeDb, execute, initDb, query, withAdvisoryLock } from '@radovin/db';
import { configureLogger, logger, newCorrelationId } from '@radovin/observability';

const schema = z.object({
  DATABASE_URL: z.string().min(1, 'A DATABASE_URL kotelezo.'),
  DATABASE_SSL: z.string().optional(),
  REDIS_URL: z.string().default('redis://127.0.0.1:6379'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  LOG_FORMAT: z.enum(['json', 'pretty']).default('json'),
  SCHEDULER_TICK_SECONDS: z.string().optional(),
  TZ: z.string().default('Europe/Budapest'),
});

const JOB_OPTIONS: JobsOptions = {
  attempts: 2,
  backoff: { type: 'exponential', delay: 30_000 },
  removeOnComplete: { age: 7 * 24 * 3600, count: 1000 },
  removeOnFail: { age: 30 * 24 * 3600, count: 2000 },
};

const queues = new Map<string, Queue>();
let connection: Redis | null = null;

function getQueue(name: string, redisUrl: string): Queue {
  const existing = queues.get(name);
  if (existing) return existing;
  if (!connection) {
    connection = new Redis(redisUrl, { maxRetriesPerRequest: null });
    connection.on('error', (err: Error) => logger.error('redis.error', { error: err.message }));
  }
  const queue = new Queue(name, { connection });
  queues.set(name, queue);
  return queue;
}

interface ScheduleInput {
  redisUrl: string;
  queue: string;
  name: string;
  payload: Record<string, unknown>;
  idempotencyKey: string;
  priority?: number;
  shopId?: string | null;
}

async function schedule(input: ScheduleInput): Promise<boolean> {
  const queue = getQueue(input.queue, input.redisUrl);
  // A BullMQ nem fogad el ketpontot a custom job ID-ban (Redis kulcs-elvalaszto).
  const jobId = input.idempotencyKey.replace(/[^A-Za-z0-9_.-]/g, '-').slice(0, 200);
  try {
    const existing = await queue.getJob(jobId).catch(() => null);
    if (existing) {
      const state = await existing.getState().catch(() => 'unknown');
      if (state === 'waiting' || state === 'active' || state === 'delayed') return false;
      await existing.remove().catch(() => undefined);
    }
    const job = await queue.add(input.name, input.payload, {
      ...JOB_OPTIONS,
      jobId,
      ...(input.priority !== undefined ? { priority: input.priority } : {}),
    });
    await execute(
      `INSERT INTO job_runs (queue, job_name, external_job_id, idempotency_key, status,
                             priority, shop_id, payload)
       VALUES ($1,$2,$3,$4,'queued',$5,$6,$7::jsonb) ON CONFLICT DO NOTHING`,
      [
        input.queue, input.name, String(job.id), input.idempotencyKey,
        input.priority ?? 100, input.shopId ?? null, JSON.stringify(input.payload),
      ],
    ).catch(() => undefined);
    return true;
  } catch (err) {
    logger.warn('scheduler.enqueue_failed', {
      queue: input.queue, name: input.name,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

/**
 * Egy utemezesi kor. Advisory lock alatt fut, igy tobb scheduler peldany
 * egyszerre sem duplikal (Coolify tobbkonteneres deploy).
 */
async function tick(redisUrl: string): Promise<void> {
  const correlationId = newCorrelationId();
  const result = await withAdvisoryLock('radovin:scheduler:tick', async () => {
    const scheduled: Record<string, number> = {};
    const bump = (key: string) => { scheduled[key] = (scheduled[key] ?? 0) + 1; };

    // ── 1. Esedekes teljes katalogus-discovery ──────────────────────────
    const dueDiscovery = await query<{ id: string; key: string; adapter_key: string }>(
      `SELECT id, key, adapter_key FROM shops
        WHERE active AND NOT policy_disabled
          AND legal_review_status IN ('approved','pending')
          AND (next_discovery_at IS NULL OR next_discovery_at <= now())
          AND NOT EXISTS (
            SELECT 1 FROM crawl_runs r
             WHERE r.shop_id = shops.id AND r.run_type = 'discovery' AND r.status = 'running')
        ORDER BY next_discovery_at NULLS FIRST
        LIMIT 5`,
    );
    for (const shop of dueDiscovery) {
      const browser = shop.adapter_key === 'browser-jsonld';
      const ok = await schedule({
        redisUrl,
        queue: browser ? 'shop-discovery-browser' : 'shop-discovery-http',
        name: 'discovery',
        payload: { shopId: shop.id, trigger: 'scheduler', correlationId },
        idempotencyKey: `discovery:${shop.id}`,
        priority: 5, shopId: shop.id,
      });
      if (ok) bump('discovery');
    }

    // ── 2. Esedekes arfrissites ─────────────────────────────────────────
    const dueRefresh = await query<{ id: string; key: string }>(
      `SELECT id, key FROM shops
        WHERE active AND NOT policy_disabled
          AND (next_price_refresh_at IS NULL OR next_price_refresh_at <= now())
        ORDER BY next_price_refresh_at NULLS FIRST
        LIMIT 10`,
    );
    for (const shop of dueRefresh) {
      const ok = await schedule({
        redisUrl, queue: 'known-listing-refresh', name: 'refresh-shop',
        payload: { shopId: shop.id, trigger: 'scheduler', correlationId },
        idempotencyKey: `refresh:${shop.id}`,
        priority: 4, shopId: shop.id,
      });
      if (ok) bump('price_refresh');
    }

    // ── 3. Nem talalt termekek ujrakeresese ─────────────────────────────
    const pendingResearch = await query<{ count: number }>(
      `SELECT count(*)::int AS count FROM variant_shop_status
        WHERE next_search_at IS NOT NULL AND next_search_at <= now()
          AND status NOT IN ('auto_verified','human_verified','suspended')`,
    );
    if ((pendingResearch[0]?.count ?? 0) > 0) {
      const ok = await schedule({
        redisUrl, queue: 'unmatched-research', name: 'research',
        payload: { limit: 200, correlationId },
        idempotencyKey: 'research:batch',
        priority: 6,
      });
      if (ok) bump('research');
    }

    // ── 4. Health check azoknal, ahol regen volt ────────────────────────
    const dueHealth = await query<{ id: string; key: string }>(
      `SELECT id, key FROM shops
        WHERE active AND NOT policy_disabled
          AND (health_checked_at IS NULL OR health_checked_at < now() - interval '6 hours')
        ORDER BY health_checked_at NULLS FIRST LIMIT 5`,
    );
    for (const shop of dueHealth) {
      const ok = await schedule({
        redisUrl, queue: 'shop-discovery-http', name: 'health-check',
        payload: { shopId: shop.id, trigger: 'scheduler', correlationId },
        idempotencyKey: `health:${shop.id}`,
        priority: 3, shopId: shop.id,
      });
      if (ok) bump('health_check');
    }

    // ── 5. Aggregatum ujraepitese oránként ──────────────────────────────
    const lastPublication = await query<{ minutes: number }>(
      `SELECT EXTRACT(EPOCH FROM (now() - coalesce(max(published_at), now() - interval '1 day'))) / 60 AS minutes
         FROM market_publications WHERE status = 'published'`,
    );
    if ((lastPublication[0]?.minutes ?? 999) > 55) {
      const ok = await schedule({
        redisUrl, queue: 'aggregate-dashboard', name: 'rebuild',
        payload: { trigger: 'scheduler', correlationId },
        idempotencyKey: 'aggregate:rebuild',
      });
      if (ok) bump('aggregate');
    }

    // ── 6. Riasztasok kikuldese ─────────────────────────────────────────
    const pendingAlerts = await query<{ count: number }>(
      `SELECT count(*)::int AS count FROM alerts
        WHERE resolved_at IS NULL AND dispatched_at IS NULL`,
    );
    if ((pendingAlerts[0]?.count ?? 0) > 0) {
      const ok = await schedule({
        redisUrl, queue: 'alert-dispatch', name: 'dispatch',
        payload: { correlationId }, idempotencyKey: 'alerts:dispatch',
      });
      if (ok) bump('alerts');
    }

    // ── 7. Retencios takaritas naponta egyszer, hajnalban ───────────────
    const hour = new Date().getHours();
    if (hour === 3) {
      const ok = await schedule({
        redisUrl, queue: 'retention-cleanup', name: 'cleanup',
        payload: { correlationId },
        idempotencyKey: `cleanup:${new Date().toISOString().slice(0, 10)}`,
        priority: 9,
      });
      if (ok) bump('cleanup');
    }

    // ── 8. SLA-figyeles: nincs sikeres futas az elvart idon belul ───────
    const stale = await query<{ key: string; name: string; hours: number }>(
      `SELECT key, name,
              EXTRACT(EPOCH FROM (now() - coalesce(last_successful_discovery_at, created_at))) / 3600 AS hours
         FROM shops
        WHERE active AND NOT policy_disabled
          AND coalesce(last_successful_discovery_at, created_at)
              < now() - ((discovery_interval_hours * 3) || ' hours')::interval`,
    );
    for (const shop of stale) {
      await execute(
        `INSERT INTO alerts (alert_key, level, category, title, message, shop_id, detail)
         SELECT $1, 'warn', 'crawler',
                $2, $3, id, $4::jsonb
           FROM shops WHERE key = $5
         ON CONFLICT (alert_key) WHERE resolved_at IS NULL
         DO UPDATE SET occurrence_count = alerts.occurrence_count + 1, last_seen_at = now()`,
        [
          `sla:no_discovery:${shop.key}`,
          `Nincs sikeres discovery: ${shop.name}`,
          `Az utolso sikeres teljes futas ${Math.round(shop.hours)} oraja volt, ami tullepi a beallitott SLA-t.`,
          JSON.stringify({ hoursSinceSuccess: Math.round(shop.hours) }),
          shop.key,
        ],
      ).catch(() => undefined);
    }

    return scheduled;
  }, { waitMs: 2000 });

  if (result === null) {
    logger.debug('scheduler.tick_skipped', { reason: 'Egy masik peldany eppen fut.' });
    return;
  }
  const total = Object.values(result).reduce((a, b) => a + b, 0);
  if (total > 0) logger.info('scheduler.tick', result);
  else logger.debug('scheduler.tick_idle');
}

async function main(): Promise<void> {
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Ervenytelen scheduler konfiguracio:\n${issues}`);
  }
  const env = parsed.data;
  process.env.TZ = env.TZ;

  configureLogger({
    level: env.LOG_LEVEL,
    pretty: env.LOG_FORMAT === 'pretty',
    service: 'scheduler',
  });

  initDb({
    connectionString: env.DATABASE_URL,
    ssl: env.DATABASE_SSL === 'true',
    max: 4,
    applicationName: 'radovin-scheduler',
  });
  await query('SELECT 1');

  const tickSeconds = Number.parseInt(env.SCHEDULER_TICK_SECONDS ?? '60', 10) || 60;
  logger.info('scheduler.starting', { tickSeconds });

  let running = true;
  let timer: NodeJS.Timeout | null = null;

  const loop = async (): Promise<void> => {
    if (!running) return;
    try {
      await tick(env.REDIS_URL);
    } catch (err) {
      logger.error('scheduler.tick_failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    if (running) timer = setTimeout(() => void loop(), tickSeconds * 1000);
  };

  await loop();

  const shutdown = async (signal: string): Promise<void> => {
    logger.info('scheduler.shutdown', { signal });
    running = false;
    if (timer) clearTimeout(timer);
    for (const q of queues.values()) await q.close().catch(() => undefined);
    if (connection) await connection.quit().catch(() => undefined);
    await closeDb();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  process.stderr.write(`\nA scheduler nem indult el:\n${err instanceof Error ? err.message : String(err)}\n\n`);
  process.exit(1);
});
