/**
 * AdapterContext epito. Osszekoti a crawler-core letoltoit, a diagnosztikai
 * szamlalokat, a robots-allapotot es az artefaktmentest az adapterekkel.
 */
import type {
  AdapterContext, AdapterDiagnostics, ShopConfig,
} from '@radovin/contracts';
import { emptyDiagnostics } from '@radovin/contracts';
import { createBrowserFetcher, createFetcher, isBrowserAvailable, loadRobots, type RobotsTxt } from '@radovin/crawler-core';
import { logger } from '@radovin/observability';

export interface BuildContextOptions {
  shop: ShopConfig;
  runId: string;
  correlationId: string;
  userAgent: string;
  contactEmail?: string;
  allowBrowser?: boolean;
  signal?: AbortSignal;
  saveArtifact?: AdapterContext['saveArtifact'];
  limits?: Partial<AdapterContext['limits']>;
  /** Elore betoltott robots.txt, hogy futasonkent csak egyszer keruljon le. */
  robots?: RobotsTxt | null;
  /** Taxonomia-feloldok, amiket az adapter tovabbad az extractionnek. */
  resolvers?: {
    resolveBrand?: unknown;
    resolveProducer?: unknown;
    resolveCategory?: unknown;
  };
}

export interface BuiltContext {
  ctx: AdapterContext;
  diagnostics: AdapterDiagnostics;
  counters: Record<string, number>;
}

const DEFAULT_LIMITS = {
  maxPages: 500,
  maxUrls: 20_000,
  maxDurationMs: 40 * 60 * 1000,
};

export async function buildAdapterContext(opts: BuildContextOptions): Promise<BuiltContext> {
  const counters: Record<string, number> = {};
  const diagnostics = emptyDiagnostics(opts.shop.adapterKey, opts.shop.adapterVersion);

  const count = (key: string, by = 1): void => {
    counters[key] = (counters[key] ?? 0) + by;
    switch (key) {
      case 'requests_attempted': diagnostics.requestsAttempted += by; break;
      case 'requests_succeeded': diagnostics.requestsSucceeded += by; break;
      case 'requests_failed': diagnostics.requestsFailed += by; break;
      case 'requests_retried': diagnostics.requestsRetried += by; break;
      case 'rate_limit_hits': diagnostics.rateLimitHits += by; break;
      case 'redirects': diagnostics.redirects += by; break;
      case 'browser_requests': diagnostics.browserUsed = true; break;
      default:
        if (key.startsWith('http_')) {
          const status = key.slice(5);
          diagnostics.httpStatusCounts[status] = (diagnostics.httpStatusCounts[status] ?? 0) + by;
        }
    }
  };

  const robots = opts.robots !== undefined
    ? opts.robots
    : opts.shop.crawlPolicy.respectRobots
      ? await loadRobots(opts.shop.baseUrl, opts.shop.crawlPolicy.userAgent ?? opts.userAgent)
      : null;

  if (robots) {
    diagnostics.robotsDecision = `robots.txt betoltve, ${robots.groups.length} csoport, ${robots.sitemaps.length} sitemap`;
  } else {
    diagnostics.robotsDecision = 'Nincs elerheto robots.txt - RFC 9309 szerint megengedo ertelmezes.';
  }

  const hostAllowlist = [opts.shop.canonicalHost, ...opts.shop.alternateHosts];
  const conditionalCache = new Map<string, { etag?: string; lastModified?: string }>();

  const fetchFn = createFetcher(opts.shop.key, {
    policy: opts.shop.crawlPolicy,
    userAgent: opts.userAgent,
    ...(opts.contactEmail ? { contactEmail: opts.contactEmail } : {}),
    hostAllowlist,
    robots,
    count,
    ...(opts.signal ? { signal: opts.signal } : {}),
    conditionalCache,
  });

  let fetchWithBrowser: AdapterContext['fetchWithBrowser'];
  if (opts.allowBrowser && opts.shop.crawlPolicy.allowBrowser && (await isBrowserAvailable())) {
    fetchWithBrowser = createBrowserFetcher({
      policy: opts.shop.crawlPolicy,
      userAgent: opts.userAgent,
      count,
      hostAllowlist,
    });
  }

  const shopWithResolvers: ShopConfig = {
    ...opts.shop,
    adapterConfig: { ...opts.shop.adapterConfig, ...(opts.resolvers ?? {}) },
  };

  const ctx: AdapterContext = {
    shop: shopWithResolvers,
    runId: opts.runId,
    correlationId: opts.correlationId,
    fetch: fetchFn,
    ...(fetchWithBrowser ? { fetchWithBrowser } : {}),
    now: () => new Date(),
    ...(opts.signal ? { signal: opts.signal } : {}),
    count,
    log: (event, data) => logger.info(`adapter.${event}`, {
      shopKey: opts.shop.key, runId: opts.runId, correlationId: opts.correlationId, ...data,
    }),
    ...(opts.saveArtifact ? { saveArtifact: opts.saveArtifact } : {}),
    limits: { ...DEFAULT_LIMITS, ...(opts.limits ?? {}) },
  };

  return { ctx, diagnostics, counters };
}
