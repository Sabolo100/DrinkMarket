/**
 * Kornyezeti konfiguracio validalva. Secret SOHA nem kerul kodba, fixture-be,
 * screenshotba vagy logba (spec 38/12).
 */
import { z } from 'zod';

const boolish = (def: boolean) =>
  z.union([z.string(), z.boolean()])
    .optional()
    .transform((v) => {
      if (v === undefined || v === '') return def;
      if (typeof v === 'boolean') return v;
      return ['1', 'true', 'yes', 'igen', 'on'].includes(v.toLowerCase());
    });

const intish = (def: number) =>
  z.string().optional().transform((v) => {
    if (!v) return def;
    const n = Number.parseInt(v, 10);
    return Number.isFinite(n) ? n : def;
  });

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('production'),
  APP_NAME: z.string().default('RADOVIN Price Intelligence'),
  APP_BASE_URL: z.string().default('http://localhost:3000'),
  TZ: z.string().default('Europe/Budapest'),

  DATABASE_URL: z.string().min(1, 'A DATABASE_URL kotelezo.'),
  DATABASE_SSL: boolish(false),
  DATABASE_POOL_MAX: intish(12),
  DB_AUTO_MIGRATE: boolish(true),

  REDIS_URL: z.string().default('redis://127.0.0.1:6379'),

  API_PORT: intish(4000),
  API_HOST: z.string().default('0.0.0.0'),
  SESSION_SECRET: z.string().min(32, 'A SESSION_SECRET legalabb 32 karakter legyen (javasolt: openssl rand -hex 32).'),
  SESSION_TTL_HOURS: intish(12),
  COOKIE_DOMAIN: z.string().optional(),
  COOKIE_SECURE: boolish(true),
  CORS_ORIGINS: z.string().default(''),

  BOOTSTRAP_ADMIN_EMAIL: z.string().optional(),
  BOOTSTRAP_ADMIN_PASSWORD: z.string().optional(),

  CRAWLER_USER_AGENT: z.string().default('RadovinPriceBot/2.1 (+https://radovin.hu/bot)'),
  CRAWLER_CONTACT_EMAIL: z.string().optional(),

  EVIDENCE_DRIVER: z.enum(['fs', 's3']).default('fs'),
  EVIDENCE_FS_PATH: z.string().default('./storage/evidence'),
  EVIDENCE_RETENTION_DAYS: intish(60),

  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  LOG_FORMAT: z.enum(['json', 'pretty']).default('json'),
});

export type AppConfig = z.infer<typeof schema> & {
  corsOrigins: string[];
  isProduction: boolean;
};

let cached: AppConfig | null = null;

export function loadConfig(): AppConfig {
  if (cached) return cached;
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Ervenytelen kornyezeti konfiguracio:\n${issues}`);
  }
  const value = parsed.data;
  cached = {
    ...value,
    corsOrigins: value.CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean),
    isProduction: value.NODE_ENV === 'production',
  };
  return cached;
}
