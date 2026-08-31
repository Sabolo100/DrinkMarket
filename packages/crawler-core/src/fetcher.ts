/**
 * HTTP letolto rate limittel, exponencialis backoff-fal, robots-ellenorzessel,
 * feltételes keresekkel es SSRF-vedelemmel (spec 11.5, 19.2, 29.1).
 */
import type { CrawlPolicy, FetchInit, FetchResponse } from '@radovin/contracts';
import { logger, metrics } from '@radovin/observability';
import { assertSafeUrl, evaluateResponse, SsrfError } from './guard.js';
import { isAllowed, parseRobots, type RobotsTxt } from './robots.js';

export interface FetcherOptions {
  policy: CrawlPolicy;
  userAgent: string;
  contactEmail?: string;
  hostAllowlist?: string[];
  robots?: RobotsTxt | null;
  respectRobots?: boolean;
  /** Diagnosztikai szamlalo. */
  count?: (key: string, by?: number) => void;
  signal?: AbortSignal;
  /** ETag/Last-Modified cache: urlKey -> { etag, lastModified }. */
  conditionalCache?: Map<string, { etag?: string; lastModified?: string }>;
}

/** Token bucket rate limiter forrasonkent. */
export class RateLimiter {
  private tokens: number;
  private lastRefill = Date.now();
  private queue: Array<() => void> = [];
  private draining = false;

  constructor(
    private readonly ratePerSecond: number,
    private readonly burst = Math.max(1, Math.ceil(ratePerSecond)),
  ) {
    this.tokens = this.burst;
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = (now - this.lastRefill) / 1000;
    if (elapsed <= 0) return;
    this.tokens = Math.min(this.burst, this.tokens + elapsed * this.ratePerSecond);
    this.lastRefill = now;
  }

  async acquire(): Promise<void> {
    return new Promise((resolve) => {
      this.queue.push(resolve);
      void this.drain();
    });
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.queue.length) {
        this.refill();
        if (this.tokens >= 1) {
          this.tokens -= 1;
          const next = this.queue.shift();
          next?.();
        } else {
          const waitMs = Math.max(20, Math.ceil(((1 - this.tokens) / this.ratePerSecond) * 1000));
          await sleep(waitMs);
        }
      }
    } finally {
      this.draining = false;
    }
  }
}

/** Egyideju keresek szama forrasonkent. */
export class Semaphore {
  private active = 0;
  private queue: Array<() => void> = [];
  constructor(private readonly limit: number) {}

  async acquire(): Promise<() => void> {
    if (this.active < this.limit) {
      this.active++;
      return () => this.release();
    }
    await new Promise<void>((resolve) => this.queue.push(resolve));
    this.active++;
    return () => this.release();
  }

  private release(): void {
    this.active--;
    const next = this.queue.shift();
    if (next) next();
  }
}

const limiters = new Map<string, { limiter: RateLimiter; semaphore: Semaphore }>();

export function limiterFor(hostKey: string, policy: CrawlPolicy): { limiter: RateLimiter; semaphore: Semaphore } {
  const existing = limiters.get(hostKey);
  if (existing) return existing;
  const created = {
    limiter: new RateLimiter(policy.requestsPerSecond),
    semaphore: new Semaphore(policy.maxConcurrency),
  };
  limiters.set(hostKey, created);
  return created;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export class RobotsDisallowedError extends Error {
  constructor(public readonly url: string, public readonly rule: string) {
    super(`A robots.txt tiltja: ${url} (${rule})`);
    this.name = 'RobotsDisallowedError';
  }
}

/** robots.txt letoltese es feldolgozasa egy hosthoz. */
export async function loadRobots(baseUrl: string, userAgent: string): Promise<RobotsTxt | null> {
  try {
    const robotsUrl = new URL('/robots.txt', baseUrl).toString();
    await assertSafeUrl(robotsUrl);
    const res = await fetch(robotsUrl, {
      headers: { 'user-agent': userAgent, accept: 'text/plain,*/*' },
      redirect: 'follow',
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return null;
    const text = await res.text();
    return parseRobots(text);
  } catch (err) {
    logger.warn('crawler.robots.fetch_failed', {
      baseUrl, error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * Letoltes rate limittel, retryval es minosegellenorzessel.
 * A visszaadott `guard` mezo mondja meg, hogy a 200-as valasz valoban
 * hasznalhato-e (spec 11.4).
 */
export function createFetcher(hostKey: string, opts: FetcherOptions) {
  const { limiter, semaphore } = limiterFor(hostKey, opts.policy);
  const ua = opts.policy.userAgent ?? opts.userAgent;
  const count = opts.count ?? (() => undefined);

  return async function doFetch(rawUrl: string, init: FetchInit = {}): Promise<FetchResponse> {
    const started = Date.now();
    const url = await assertSafeUrl(rawUrl, { hostAllowlist: opts.hostAllowlist });

    // robots.txt ellenorzes
    if (opts.respectRobots !== false && opts.policy.respectRobots) {
      const decision = isAllowed(opts.robots ?? null, url.toString(), ua);
      if (!decision.allowed) {
        count('robots_blocked');
        throw new RobotsDisallowedError(url.toString(), decision.matchedRule ?? 'ismeretlen');
      }
    }

    const release = await semaphore.acquire();
    try {
      const maxAttempts = opts.policy.maxRetries + 1;
      let lastError: unknown = null;

      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        await limiter.acquire();
        count('requests_attempted');
        if (attempt > 1) count('requests_retried');

        const headers: Record<string, string> = {
          'user-agent': ua,
          accept: init.acceptJson
            ? 'application/json,text/plain;q=0.9,*/*;q=0.8'
            : 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'accept-language': 'hu-HU,hu;q=0.9,en;q=0.6',
          'accept-encoding': 'gzip, deflate, br',
          ...(opts.contactEmail ? { from: opts.contactEmail } : {}),
          ...(init.headers ?? {}),
        };
        const cached = opts.conditionalCache?.get(rawUrl);
        if (cached?.etag) headers['if-none-match'] = cached.etag;
        if (cached?.lastModified) headers['if-modified-since'] = cached.lastModified;
        if (init.etag) headers['if-none-match'] = init.etag;
        if (init.lastModified) headers['if-modified-since'] = init.lastModified;

        const timeoutMs = init.timeoutMs ?? opts.policy.requestTimeoutMs;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        const onParentAbort = () => controller.abort();
        opts.signal?.addEventListener('abort', onParentAbort, { once: true });

        try {
          const res = await fetch(url.toString(), {
            method: init.method ?? 'GET',
            headers,
            body: init.body,
            redirect: 'follow',
            signal: controller.signal,
          });

          const finalUrl = res.url || url.toString();
          count(`http_${res.status}`);

          // 304: nem valtozott
          if (res.status === 304) {
            count('requests_succeeded');
            return {
              ok: true, status: 304, url: rawUrl, finalUrl,
              redirectChain: [], headers: headersToObject(res.headers),
              body: '', contentType: res.headers.get('content-type') ?? '',
              fromCache: true, timingMs: Date.now() - started,
              guard: { blocked: false, reason: 'ok' },
            };
          }

          // 429 / Retry-After tiszteletben tartasa
          if (res.status === 429 || res.status === 503) {
            count('rate_limit_hits');
            const retryAfter = parseRetryAfter(res.headers.get('retry-after'));
            if (attempt < maxAttempts) {
              const waitMs = retryAfter ?? backoffDelay(attempt, opts.policy);
              logger.warn('crawler.rate_limited', { url: rawUrl, status: res.status, waitMs, attempt });
              metrics.counter('crawler.rate_limited', 1, { host: hostKey });
              await sleep(Math.min(waitMs, 120_000));
              continue;
            }
          }

          const contentType = res.headers.get('content-type') ?? '';
          const body = await res.text();

          if (opts.conditionalCache) {
            const etag = res.headers.get('etag');
            const lastModified = res.headers.get('last-modified');
            if (etag || lastModified) {
              opts.conditionalCache.set(rawUrl, {
                ...(etag ? { etag } : {}),
                ...(lastModified ? { lastModified } : {}),
              });
            }
          }

          const guard = evaluateResponse({ status: res.status, body, contentType, url: finalUrl });

          if (!res.ok && res.status >= 500 && attempt < maxAttempts) {
            await sleep(backoffDelay(attempt, opts.policy));
            continue;
          }

          if (res.ok) count('requests_succeeded');
          else count('requests_failed');
          if (finalUrl !== url.toString()) count('redirects');

          metrics.timing('crawler.request_ms', Date.now() - started, { host: hostKey, status: String(res.status) });

          return {
            ok: res.ok && !guard.blocked,
            status: res.status,
            url: rawUrl,
            finalUrl,
            redirectChain: finalUrl !== url.toString() ? [url.toString(), finalUrl] : [],
            headers: headersToObject(res.headers),
            body,
            contentType,
            fromCache: false,
            timingMs: Date.now() - started,
            guard,
          };
        } catch (err) {
          lastError = err;
          if (err instanceof SsrfError) throw err;
          const isAbort = err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError');
          count(isAbort ? 'timeouts' : 'requests_failed');
          if (attempt < maxAttempts) {
            await sleep(backoffDelay(attempt, opts.policy));
            continue;
          }
        } finally {
          clearTimeout(timer);
          opts.signal?.removeEventListener('abort', onParentAbort);
        }
      }

      const message = lastError instanceof Error ? lastError.message : String(lastError);
      const isTimeout = lastError instanceof Error && (lastError.name === 'AbortError' || lastError.name === 'TimeoutError');
      return {
        ok: false, status: isTimeout ? 408 : 0, url: rawUrl, finalUrl: rawUrl,
        redirectChain: [], headers: {}, body: '', contentType: '',
        fromCache: false, timingMs: Date.now() - started,
        guard: { blocked: true, reason: isTimeout ? 'challenge' : 'challenge', detail: message },
      };
    } finally {
      release();
    }
  };
}

/** Exponencialis backoff jitterrel (spec 11.5). */
export function backoffDelay(attempt: number, policy: CrawlPolicy): number {
  const base = policy.backoffBaseMs * Math.pow(2, attempt - 1);
  const capped = Math.min(base, policy.backoffMaxMs);
  const jitter = capped * 0.25 * Math.random();
  return Math.round(capped * 0.75 + jitter);
}

function parseRetryAfter(value: string | null): number | null {
  if (!value) return null;
  const seconds = Number.parseInt(value, 10);
  if (Number.isFinite(seconds)) return seconds * 1000;
  const date = Date.parse(value);
  if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  return null;
}

function headersToObject(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    // Erzekeny fejlecek nem kerulnek a naploba/tarolasba (spec 29.1)
    if (/^(set-cookie|cookie|authorization|proxy-authorization)$/i.test(key)) return;
    out[key.toLowerCase()] = value;
  });
  return out;
}
