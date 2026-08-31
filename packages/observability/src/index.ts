/**
 * Strukturált JSON logolás + korrelációs kontextus + egyszerű metrikagyűjtő.
 * Spec 30.1 - 30.2.
 *
 * FONTOS (spec 29.1): cookie, auth header, token, jelszó és teljes érzékeny
 * HTML SOHA nem kerülhet a logba. A redact() minden kimenetre lefut.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface LogContext {
  correlationId?: string;
  runId?: string;
  jobId?: string;
  shopId?: string;
  shopKey?: string;
  listingId?: string;
  canonicalVariantId?: string;
  userId?: string;
  adapterVersion?: string;
  matcherVersion?: string;
  [key: string]: unknown;
}

const storage = new AsyncLocalStorage<LogContext>();

export function withContext<T>(ctx: LogContext, fn: () => T): T {
  const parent = storage.getStore() ?? {};
  return storage.run({ ...parent, ...ctx }, fn);
}

export function currentContext(): LogContext {
  return storage.getStore() ?? {};
}

export function newCorrelationId(): string {
  return randomUUID();
}

const SENSITIVE_KEYS = new Set([
  'password', 'passwordhash', 'password_hash', 'token', 'tokenhash', 'token_hash',
  'authorization', 'cookie', 'setcookie', 'set-cookie', 'apikey', 'api_key',
  'secret', 'sessionsecret', 'session_secret', 'csrf', 'csrftoken', 'accesskey',
  'accesskeyid', 'secretaccesskey', 'anthropic_api_key', 'invite_token_hash',
  'connectionstring', 'database_url', 'redis_url',
]);

const MAX_STRING = 2000;

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[deep]';
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') {
    return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…[${value.length}]` : value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack?.split('\n').slice(0, 6).join('\n') };
  }
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redact(v, depth + 1));
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SENSITIVE_KEYS.has(k.toLowerCase().replace(/[-_]/g, ''))) {
        out[k] = '[redacted]';
      } else if (SENSITIVE_KEYS.has(k.toLowerCase())) {
        out[k] = '[redacted]';
      } else {
        out[k] = redact(v, depth + 1);
      }
    }
    return out;
  }
  return String(value);
}

let minLevel: LogLevel = (process.env.LOG_LEVEL as LogLevel) || 'info';
let pretty = process.env.LOG_FORMAT === 'pretty' || process.env.NODE_ENV === 'development';
let serviceName = process.env.SERVICE_NAME || 'radovin';

export function configureLogger(opts: { level?: LogLevel; pretty?: boolean; service?: string }): void {
  if (opts.level) minLevel = opts.level;
  if (opts.pretty !== undefined) pretty = opts.pretty;
  if (opts.service) serviceName = opts.service;
}

const LEVEL_COLOR: Record<LogLevel, string> = {
  debug: '\x1b[90m', info: '\x1b[36m', warn: '\x1b[33m', error: '\x1b[31m',
};

function emit(level: LogLevel, event: string, data?: Record<string, unknown>): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[minLevel]) return;
  const ctx = currentContext();
  const record = {
    ts: new Date().toISOString(),
    level,
    service: serviceName,
    event,
    ...(redact(ctx) as Record<string, unknown>),
    ...(data ? (redact(data) as Record<string, unknown>) : {}),
  };
  if (pretty) {
    const { ts, level: lv, event: ev, service, ...rest } = record as Record<string, unknown>;
    const color = LEVEL_COLOR[level];
    const detail = Object.keys(rest).length ? ` ${JSON.stringify(rest)}` : '';
    process.stdout.write(`${color}${String(lv).toUpperCase().padEnd(5)}\x1b[0m ${String(ts).slice(11, 23)} ${ev}${detail}\n`);
  } else {
    process.stdout.write(`${JSON.stringify(record)}\n`);
  }
}

export const logger = {
  debug: (event: string, data?: Record<string, unknown>) => emit('debug', event, data),
  info: (event: string, data?: Record<string, unknown>) => emit('info', event, data),
  warn: (event: string, data?: Record<string, unknown>) => emit('warn', event, data),
  error: (event: string, data?: Record<string, unknown>) => emit('error', event, data),
  child: (ctx: LogContext) => ({
    debug: (e: string, d?: Record<string, unknown>) => withContext(ctx, () => emit('debug', e, d)),
    info: (e: string, d?: Record<string, unknown>) => withContext(ctx, () => emit('info', e, d)),
    warn: (e: string, d?: Record<string, unknown>) => withContext(ctx, () => emit('warn', e, d)),
    error: (e: string, d?: Record<string, unknown>) => withContext(ctx, () => emit('error', e, d)),
  }),
};

// ── Egyszerű, in-process metrikagyűjtő (spec 30.2) ──────────────────────────
type MetricSink = (m: { metric: string; value: number; labels: Record<string, string> }) => void;

const sinks: MetricSink[] = [];
export function addMetricSink(sink: MetricSink): void {
  sinks.push(sink);
}

export const metrics = {
  counter(metric: string, value = 1, labels: Record<string, string> = {}): void {
    for (const s of sinks) s({ metric, value, labels });
  },
  gauge(metric: string, value: number, labels: Record<string, string> = {}): void {
    for (const s of sinks) s({ metric, value, labels });
  },
  timing(metric: string, ms: number, labels: Record<string, string> = {}): void {
    for (const s of sinks) s({ metric, value: ms, labels });
  },
  async time<T>(metric: string, fn: () => Promise<T>, labels: Record<string, string> = {}): Promise<T> {
    const started = Date.now();
    try {
      return await fn();
    } finally {
      for (const s of sinks) s({ metric, value: Date.now() - started, labels });
    }
  },
};

/** Egységes alkalmazáshiba, stabil hibakóddal (spec 21.7). */
export class AppError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly statusCode = 400,
    public readonly detail?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'AppError';
  }
}
