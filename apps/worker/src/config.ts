/** Worker konfiguracio. */
import { z } from 'zod';

const boolish = (def: boolean) =>
  z.string().optional().transform((v) => {
    if (v === undefined || v === '') return def;
    return ['1', 'true', 'yes', 'igen', 'on'].includes(v.toLowerCase());
  });

const intish = (def: number) =>
  z.string().optional().transform((v) => {
    if (!v) return def;
    const n = Number.parseInt(v, 10);
    return Number.isFinite(n) ? n : def;
  });

const schema = z.object({
  NODE_ENV: z.string().default('production'),
  TZ: z.string().default('Europe/Budapest'),
  DATABASE_URL: z.string().min(1, 'A DATABASE_URL kotelezo.'),
  DATABASE_SSL: boolish(false),
  DATABASE_POOL_MAX: intish(8),
  REDIS_URL: z.string().default('redis://127.0.0.1:6379'),
  WORKER_MODE: z.enum(['http', 'browser', 'all']).default('http'),
  WORKER_HTTP_CONCURRENCY: intish(8),
  WORKER_BROWSER_CONCURRENCY: intish(1),
  CRAWLER_USER_AGENT: z.string().default('RadovinPriceBot/2.1 (+https://drinkdeal.hu/bot)'),
  CRAWLER_CONTACT_EMAIL: z.string().optional(),
  EVIDENCE_DRIVER: z.enum(['fs', 's3']).default('fs'),
  EVIDENCE_FS_PATH: z.string().default('./storage/evidence'),
  EVIDENCE_RETENTION_DAYS: intish(60),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  LOG_FORMAT: z.enum(['json', 'pretty']).default('json'),
  WORKER_MAX_URLS_PER_RUN: intish(20000),
  WORKER_MAX_RUN_MINUTES: intish(40),
  WORKER_MAX_CLUSTER_JOBS: intish(3000),
});

export interface WorkerConfig {
  nodeEnv: string;
  databaseUrl: string;
  databaseSsl: boolean;
  databasePoolMax: number;
  redisUrl: string;
  mode: 'http' | 'browser' | 'all';
  httpConcurrency: number;
  browserConcurrency: number;
  userAgent: string;
  contactEmail?: string;
  evidenceDriver: 'fs' | 's3';
  evidencePath: string;
  evidenceRetentionDays: number;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  logPretty: boolean;
  maxUrlsPerRun: number;
  maxRunDurationMs: number;
  maxClusterJobsPerRun: number;
}

let cached: WorkerConfig | null = null;

export function loadWorkerConfig(): WorkerConfig {
  if (cached) return cached;
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Ervenytelen worker konfiguracio:\n${issues}`);
  }
  const v = parsed.data;
  cached = {
    nodeEnv: v.NODE_ENV,
    databaseUrl: v.DATABASE_URL,
    databaseSsl: v.DATABASE_SSL,
    databasePoolMax: v.DATABASE_POOL_MAX,
    redisUrl: v.REDIS_URL,
    mode: v.WORKER_MODE,
    httpConcurrency: v.WORKER_HTTP_CONCURRENCY,
    browserConcurrency: v.WORKER_BROWSER_CONCURRENCY,
    userAgent: v.CRAWLER_USER_AGENT,
    ...(v.CRAWLER_CONTACT_EMAIL ? { contactEmail: v.CRAWLER_CONTACT_EMAIL } : {}),
    evidenceDriver: v.EVIDENCE_DRIVER,
    evidencePath: v.EVIDENCE_FS_PATH,
    evidenceRetentionDays: v.EVIDENCE_RETENTION_DAYS,
    logLevel: v.LOG_LEVEL,
    logPretty: v.LOG_FORMAT === 'pretty',
    maxUrlsPerRun: v.WORKER_MAX_URLS_PER_RUN,
    maxRunDurationMs: v.WORKER_MAX_RUN_MINUTES * 60_000,
    maxClusterJobsPerRun: v.WORKER_MAX_CLUSTER_JOBS,
  };
  return cached;
}
