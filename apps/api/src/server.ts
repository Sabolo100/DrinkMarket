import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import { ZodError } from 'zod';
import type { SessionUser } from '@radovin/contracts';
import { AppError, logger, newCorrelationId } from '@radovin/observability';
import type { AppConfig } from './config.js';
import { CSRF_HEADER, SESSION_COOKIE, resolveSession } from './lib/auth.js';
import { registerRoutes } from './routes/index.js';

declare module 'fastify' {
  interface FastifyRequest {
    user: SessionUser | null;
    sessionId: string | null;
    sessionCsrf: string | null;
    correlationId: string;
    config: AppConfig;
  }
}

const PUBLIC_PATHS = new Set([
  '/api/v1/auth/login',
  '/api/v1/health',
  '/api/v1/ready',
]);

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export async function buildServer(config: AppConfig): Promise<FastifyInstance> {
  const app = Fastify({
    logger: false,
    trustProxy: true,
    bodyLimit: 20 * 1024 * 1024,
    disableRequestLogging: true,
    genReqId: () => newCorrelationId(),
  });

  await app.register(cookie, { secret: config.SESSION_SECRET });
  await app.register(multipart, {
    limits: { fileSize: 25 * 1024 * 1024, files: 1, fields: 30 },
  });
  if (config.corsOrigins.length) {
    await app.register(cors, {
      origin: config.corsOrigins,
      credentials: true,
      allowedHeaders: ['content-type', CSRF_HEADER, 'x-idempotency-key'],
    });
  }

  // ── Biztonsagi fejlecek ──────────────────────────────────────────────────
  app.addHook('onSend', async (_req, reply, payload) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('x-frame-options', 'DENY');
    reply.header('referrer-policy', 'no-referrer');
    reply.header('permissions-policy', 'geolocation=(), microphone=(), camera=()');
    if (config.isProduction) {
      reply.header('strict-transport-security', 'max-age=31536000; includeSubDomains');
    }
    return payload;
  });

  // ── Hitelesites + CSRF (spec 4.2, 29.1) ─────────────────────────────────
  app.addHook('preHandler', async (req, reply) => {
    req.correlationId = String(req.id);
    req.config = config;
    req.user = null;
    req.sessionId = null;
    req.sessionCsrf = null;

    const token = req.cookies[SESSION_COOKIE];
    const session = await resolveSession(token);
    if (session) {
      req.user = session.user;
      req.sessionId = session.sessionId;
      req.sessionCsrf = session.csrfToken;
    }

    const path = req.routeOptions.url ?? req.url.split('?')[0] ?? '';
    if (PUBLIC_PATHS.has(path)) return;

    // 1. Hitelesites MINDEN vedett vegponton, az olvasasi kereseket is beleertve
    //    (spec 4.2: minden vegpont szerepkor-ellenorzott).
    if (!session) {
      return reply.code(401).send({
        error: { code: 'UNAUTHENTICATED', message: 'Bejelentkezes szukseges.' },
      });
    }

    // 2. CSRF-vedelem: csak az allapotmodosito metodusokra vonatkozik.
    //    A biztonsagos (GET/HEAD/OPTIONS) keresek nem valtoztatnak allapotot,
    //    ezert nem igenyelnek tokent - a hitelesites viszont rajuk is all.
    if (SAFE_METHODS.has(req.method)) return;

    const provided = req.headers[CSRF_HEADER];
    if (!provided || provided !== session.csrfToken) {
      logger.warn('security.csrf_rejected', {
        path, userId: session.user.id, correlationId: req.correlationId,
      });
      return reply.code(403).send({
        error: { code: 'CSRF_INVALID', message: 'Hianyzo vagy ervenytelen CSRF token.' },
      });
    }
  });

  // ── Keresnaplo ───────────────────────────────────────────────────────────
  app.addHook('onResponse', async (req, reply) => {
    const level = reply.statusCode >= 500 ? 'error' : reply.statusCode >= 400 ? 'warn' : 'debug';
    logger[level]('http.request', {
      method: req.method,
      path: req.routeOptions.url ?? req.url,
      status: reply.statusCode,
      durationMs: Math.round(reply.elapsedTime),
      userId: req.user?.id,
      correlationId: req.correlationId,
    });
  });

  // ── Egyseges hibakezeles (spec 21.7) ────────────────────────────────────
  app.setErrorHandler((error, req, reply) => {
    if (error instanceof AppError) {
      return reply.code(error.statusCode).send({
        error: { code: error.code, message: error.message, detail: error.detail },
      });
    }
    if (error instanceof ZodError) {
      return reply.code(400).send({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Ervenytelen keresadat.',
          detail: {
            issues: error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
          },
        },
      });
    }
    const err = error as { statusCode?: number; message?: string; stack?: string };
    const statusCode = err.statusCode ?? 500;
    if (statusCode >= 500) {
      logger.error('http.unhandled_error', {
        path: req.url,
        error: err.message ?? 'ismeretlen hiba',
        stack: err.stack?.split('\n').slice(0, 5).join('\n'),
        correlationId: req.correlationId,
      });
    }
    return reply.code(statusCode).send({
      error: {
        code: statusCode >= 500 ? 'INTERNAL_ERROR' : 'REQUEST_ERROR',
        message: statusCode >= 500
          ? 'Varatlan szerveroldali hiba. A reszletek a szerver naplojaban talalhatok.'
          : err.message ?? 'Ervenytelen keres.',
      },
    });
  });

  app.setNotFoundHandler((req, reply) => {
    reply.code(404).send({
      error: { code: 'NOT_FOUND', message: `Nincs ilyen vegpont: ${req.method} ${req.url}` },
    });
  });

  await registerRoutes(app, config);
  return app;
}

export function clientIp(req: FastifyRequest): string {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string') return forwarded.split(',')[0]?.trim() ?? req.ip;
  return req.ip;
}
