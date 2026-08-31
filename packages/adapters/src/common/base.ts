/**
 * Kozos adapter-alap (spec 11.1, 11.3).
 *
 * Az adapter feladata adatot gyujteni es BIZONYITEKOT rogziteni.
 * NEM hozhat onallo uzleti parositasi dontest (spec 38/5).
 *
 * Minden adapter ugyanazt a kimeneti szerzodest adja, ezert a kozponti
 * parositoba SOHA nem kerul webshop-specifikus szelektor vagy kod (spec 7.).
 */
import type {
  AdapterContext, DiscoveredTarget, DiscoveryResult, ExtractResult,
  HealthResult, KnownListingRef, NormalizedSourceListing, SearchQuery,
  SearchResult, ShopAdapter, SourceStatus,
} from '@radovin/contracts';
import { emptyDiagnostics } from '@radovin/contracts';
import { extractListing, looksLikeProductUrl, parseSitemap, sitemapsFromRobots } from '@radovin/extraction';
import { canonicalizeUrl, urlKey, type UrlCanonicalizationRule } from '@radovin/crawler-core';

export interface AdapterConfig {
  /** Explicit sitemap URL-ek. Ha ures, a robots.txt-bol es a szokasos utakbol probal. */
  sitemapUrls?: string[];
  /** Termek-URL felismero mintak. */
  productUrlInclude?: string[];
  productUrlExclude?: string[];
  /** Kategoriaoldalak, ha nincs sitemap. */
  categoryUrls?: string[];
  /** A webshop belso keresojenek URL-sablonja, `{query}` helyorzovel. */
  searchUrlTemplate?: string;
  /** URL-kanonizalasi szabaly (spec 11.5). */
  urlRule?: UrlCanonicalizationRule;
  /** Egeszsegellenorzeshez hasznalt stabil termek-URL. */
  healthCheckUrl?: string;
  /** A forras altal hasznalt minor unit, ha ismert. */
  minorUnitHint?: number;
  /** Kotelezo mezok az extraction_quality szamitasahoz (kategoriafuggo). */
  requiredFields?: string[];
  /** Bongeszos mod kenyszeritese (csak ha nincs statikus ut). */
  forceBrowser?: boolean;
  /** Selector, amire a bongeszos modban varni kell. */
  waitForSelector?: string;
  /** Maximalis sitemap gyerekszam egy futasban. */
  maxSitemaps?: number;
}

const DEFAULT_SITEMAP_PATHS = [
  '/sitemap.xml', '/sitemap_index.xml', '/sitemap-index.xml',
  '/wp-sitemap.xml', '/product-sitemap.xml', '/sitemap/sitemap-index.xml',
];

export abstract class BaseAdapter implements ShopAdapter {
  abstract key: string;
  abstract version: string;
  abstract capabilities: ShopAdapter['capabilities'];

  protected config(ctx: AdapterContext): AdapterConfig {
    return (ctx.shop.adapterConfig ?? {}) as AdapterConfig;
  }

  canonicalizeUrl(url: string): string {
    return canonicalizeUrl(url);
  }

  protected urlKeyFor(ctx: AdapterContext, url: string): string {
    return urlKey(url, this.config(ctx).urlRule);
  }

  // ── Health check (spec 33.3) ─────────────────────────────────────────────
  async healthCheck(ctx: AdapterContext): Promise<HealthResult> {
    const checks: HealthResult['checks'] = [];
    let status: SourceStatus = 'ok';
    let detectedPlatform: string | undefined;
    let sampleProductUrl: string | undefined;

    // 1. Alapoldal elerheto-e
    const homeStarted = Date.now();
    const home = await ctx.fetch(ctx.shop.baseUrl).catch((err: unknown) => {
      checks.push({ name: 'home', passed: false, detail: err instanceof Error ? err.message : String(err) });
      return null;
    });
    if (home) {
      checks.push({
        name: 'home',
        passed: home.ok,
        detail: `HTTP ${home.status}${home.guard.blocked ? ` - ${home.guard.reason}: ${home.guard.detail ?? ''}` : ''}`,
        durationMs: Date.now() - homeStarted,
      });
      if (home.guard.blocked) status = home.guard.reason === 'rate_limited' ? 'rate_limited' : 'blocked';
      else if (!home.ok) status = 'unavailable';
      detectedPlatform = detectPlatform(home.body);
      if (detectedPlatform) checks.push({ name: 'platform', passed: true, detail: detectedPlatform });
    } else {
      status = 'unavailable';
    }

    // 2. Sitemap / katalogusvegpont
    const sitemapUrls = await this.resolveSitemapUrls(ctx);
    checks.push({
      name: 'sitemap',
      passed: sitemapUrls.length > 0,
      detail: sitemapUrls.length ? `${sitemapUrls.length} sitemap talalva` : 'Nem talalhato sitemap',
    });

    // 3. Minta termekoldal kinyerheto-e
    const cfg = this.config(ctx);
    const probeUrl = cfg.healthCheckUrl;
    if (probeUrl) {
      const started = Date.now();
      const result = await this.extractListing(ctx, { url: probeUrl }).catch(() => null);
      const ok = result?.status === 'ok' && Boolean(result.listing?.rawName);
      checks.push({
        name: 'product_extract',
        passed: ok,
        detail: ok
          ? `Nev: ${result?.listing?.rawName}, minoseg: ${result?.listing?.extractionQuality}`
          : `Sikertelen kinyeres: ${result?.status ?? 'ismeretlen'}`,
        durationMs: Date.now() - started,
      });
      if (ok) sampleProductUrl = probeUrl;
      if (!ok && status === 'ok') status = 'parse_error';
    }

    const healthy = checks.every((c) => c.passed) && status === 'ok';
    return {
      healthy, status, checks, detectedPlatform, sampleProductUrl,
      message: healthy ? 'A forras egeszseges.' : `A forras allapota: ${status}`,
    };
  }

  // ── Discovery (spec 11.2, 11.6) ─────────────────────────────────────────
  async discover(ctx: AdapterContext): Promise<DiscoveryResult> {
    const started = Date.now();
    const diagnostics = emptyDiagnostics(this.key, this.version);
    const cfg = this.config(ctx);
    const seen = new Set<string>();
    const targets: DiscoveredTarget[] = [];
    const completenessEvidence: string[] = [];
    let status: SourceStatus = 'ok';

    const sitemapUrls = await this.resolveSitemapUrls(ctx);
    if (!sitemapUrls.length) {
      diagnostics.notes.push('Nem talalhato sitemap - kategoriaoldal bejaras szukseges.');
    }

    const queue = [...sitemapUrls];
    const processed = new Set<string>();
    const maxSitemaps = cfg.maxSitemaps ?? 60;

    while (queue.length && processed.size < maxSitemaps && targets.length < ctx.limits.maxUrls) {
      if (Date.now() - started > ctx.limits.maxDurationMs) {
        status = 'partial';
        diagnostics.notes.push('Idokorlat miatt reszleges discovery.');
        break;
      }
      const sm = queue.shift();
      if (!sm || processed.has(sm)) continue;
      processed.add(sm);

      const res = await ctx.fetch(sm, { acceptJson: false }).catch((err: unknown) => {
        diagnostics.errors.push({ code: 'SITEMAP_FETCH', message: String(err), url: sm });
        return null;
      });
      if (!res) { status = status === 'ok' ? 'partial' : status; continue; }
      diagnostics.pagesSeen++;
      if (res.guard.blocked) {
        status = res.guard.reason === 'rate_limited' ? 'rate_limited' : 'blocked';
        diagnostics.errors.push({ code: 'SITEMAP_BLOCKED', message: res.guard.detail ?? res.guard.reason, url: sm });
        continue;
      }
      if (!res.ok) { status = 'partial'; continue; }

      const parsed = parseSitemap(res.body);
      if (parsed.kind === 'index') {
        for (const child of parsed.children) {
          if (!processed.has(child.loc)) queue.push(child.loc);
        }
        completenessEvidence.push(`${sm}: sitemap index ${parsed.children.length} gyerekkel`);
        continue;
      }

      let added = 0;
      for (const entry of parsed.entries) {
        if (targets.length >= ctx.limits.maxUrls) break;
        if (!looksLikeProductUrl(entry.loc, {
          include: cfg.productUrlInclude,
          exclude: cfg.productUrlExclude,
        })) continue;
        const canonical = canonicalizeUrl(entry.loc, cfg.urlRule);
        const key = urlKey(canonical, cfg.urlRule);
        if (seen.has(key)) { diagnostics.urlsDuplicate++; continue; }
        seen.add(key);
        targets.push({ url: canonical, hints: entry.lastmod ? { lastmod: entry.lastmod } : undefined });
        added++;
      }
      completenessEvidence.push(`${sm}: ${parsed.entries.length} URL, ebbol ${added} termeknek tunik`);
    }

    // Kategoriaoldal fallback, ha a sitemap keveset adott
    if (targets.length === 0 && cfg.categoryUrls?.length) {
      const fromCategories = await this.discoverFromCategoryPages(ctx, cfg.categoryUrls, seen, diagnostics);
      targets.push(...fromCategories);
      completenessEvidence.push(`Kategoriaoldal bejaras: ${fromCategories.length} URL`);
      if (fromCategories.length) status = status === 'ok' ? 'partial' : status;
    }

    diagnostics.urlsDiscovered = targets.length;
    diagnostics.durationMs = Date.now() - started;

    const expectedMin = numberOrNull(ctx.shop.adapterConfig?.['expectedCatalogMin']);
    let completeness: DiscoveryResult['completeness'] = 'unknown';
    if (status === 'ok' && sitemapUrls.length && targets.length > 0) {
      completeness = expectedMin === null || targets.length >= expectedMin ? 'complete' : 'partial';
    } else if (targets.length > 0) {
      completeness = 'partial';
    }

    return {
      status,
      targets,
      diagnostics,
      completeness,
      completenessEvidence,
      catalogHash: hashUrls(targets.map((t) => t.url)),
    };
  }

  /** Kategoriaoldalak bejarasa lapozassal. Csak sitemap hianyaban fut. */
  protected async discoverFromCategoryPages(
    ctx: AdapterContext,
    categoryUrls: string[],
    seen: Set<string>,
    diagnostics: ReturnType<typeof emptyDiagnostics>,
  ): Promise<DiscoveredTarget[]> {
    const cfg = this.config(ctx);
    const out: DiscoveredTarget[] = [];
    for (const categoryUrl of categoryUrls) {
      let page = 1;
      let emptyPages = 0;
      while (page <= 200 && out.length < ctx.limits.maxUrls && emptyPages < 2) {
        const pageUrl = categoryUrl.includes('{page}')
          ? categoryUrl.replace('{page}', String(page))
          : page === 1 ? categoryUrl : `${categoryUrl}${categoryUrl.includes('?') ? '&' : '?'}page=${page}`;
        const res = await ctx.fetch(pageUrl).catch(() => null);
        if (!res?.ok || res.guard.blocked) break;
        diagnostics.pagesSeen++;
        const links = extractProductLinks(res.body, res.finalUrl, cfg);
        let added = 0;
        for (const link of links) {
          const key = urlKey(link, cfg.urlRule);
          if (seen.has(key)) { diagnostics.urlsDuplicate++; continue; }
          seen.add(key);
          out.push({ url: canonicalizeUrl(link, cfg.urlRule) });
          added++;
        }
        if (added === 0) emptyPages++;
        else emptyPages = 0;
        page++;
      }
    }
    return out;
  }

  // ── Termekoldal kinyerese ───────────────────────────────────────────────
  async extractListing(ctx: AdapterContext, target: DiscoveredTarget): Promise<ExtractResult> {
    const cfg = this.config(ctx);

    if (target.inlineListing) {
      return {
        status: 'ok',
        listing: target.inlineListing,
        diagnostics: { adapterKey: this.key, adapterVersion: this.version },
        evidence: target.inlineListing.evidence,
      };
    }

    const useBrowser = Boolean(cfg.forceBrowser && ctx.fetchWithBrowser);
    const fetcher = useBrowser ? ctx.fetchWithBrowser! : ctx.fetch;

    let res;
    try {
      res = await fetcher(target.url, {
        ...(cfg.waitForSelector ? { waitForSelector: cfg.waitForSelector } : {}),
      });
    } catch (err) {
      return {
        status: 'unavailable',
        diagnostics: {
          adapterKey: this.key, adapterVersion: this.version,
          errors: [{ code: 'FETCH_FAILED', message: err instanceof Error ? err.message : String(err), url: target.url }],
        },
        evidence: {},
      };
    }

    if (res.guard.blocked) {
      const status: ExtractResult['status'] =
        res.guard.reason === 'soft_404' ? 'unavailable'
          : res.guard.reason === 'rate_limited' ? 'blocked'
            : res.guard.reason === 'empty_shell' ? 'parse_error'
              : 'blocked';
      return {
        status,
        diagnostics: {
          adapterKey: this.key, adapterVersion: this.version,
          errors: [{ code: res.guard.reason.toUpperCase(), message: res.guard.detail ?? res.guard.reason, url: target.url }],
        },
        evidence: {},
        rawArtifact: { content: res.body.slice(0, 200_000), contentType: res.contentType },
      };
    }

    if (!res.ok) {
      return {
        status: res.status === 404 ? 'unavailable' : 'parse_error',
        diagnostics: {
          adapterKey: this.key, adapterVersion: this.version,
          errors: [{ code: `HTTP_${res.status}`, message: `HTTP ${res.status}`, url: target.url }],
        },
        evidence: {},
      };
    }

    const platform = await this.fetchPlatformData(ctx, target, res.body).catch(() => null);

    const extracted = extractListing({
      shopKey: ctx.shop.key,
      url: target.url,
      finalUrl: res.finalUrl,
      html: res.body,
      platform,
      platformProductId: target.platformProductId ?? null,
      platformVariantId: target.platformVariantId ?? null,
      urlKey: this.urlKeyFor(ctx, res.finalUrl || target.url),
      minorUnitHint: cfg.minorUnitHint,
      extractorKey: this.key,
      requiredFields: cfg.requiredFields,
      ...(ctx.shop.adapterConfig?.['resolvers'] as Record<string, never> ?? {}),
    });

    if (extracted.notProduct) {
      return {
        status: 'not_product',
        diagnostics: { adapterKey: this.key, adapterVersion: this.version, notes: extracted.warnings },
        evidence: {},
      };
    }

    extracted.listing.redirectChain = res.redirectChain;
    return {
      status: 'ok',
      listing: extracted.listing,
      diagnostics: { adapterKey: this.key, adapterVersion: this.version, notes: extracted.warnings },
      evidence: extracted.listing.evidence,
      ...(extracted.warnings.length
        ? { rawArtifact: { content: res.body.slice(0, 200_000), contentType: res.contentType } }
        : {}),
    };
  }

  /** Platformspecifikus kiegeszito adat. Alapertelmezesben nincs. */
  protected async fetchPlatformData(
    _ctx: AdapterContext,
    _target: DiscoveredTarget,
    _html: string,
  ): Promise<Record<string, unknown> | null> {
    return null;
  }

  // ── Ismert listing kozvetlen frissitese (spec 11.7) ─────────────────────
  async refreshKnownListing(ctx: AdapterContext, listing: KnownListingRef): Promise<ExtractResult> {
    // 1. Platform product/variant ID az elsodleges
    if (listing.platformProductId && this.capabilities.platformApi) {
      const byId = await this.extractByPlatformId(ctx, listing).catch(() => null);
      if (byId && byId.status === 'ok') return byId;
    }
    // 2. Kanonikus URL
    return this.extractListing(ctx, {
      url: listing.canonicalUrl,
      platformProductId: listing.platformProductId ?? undefined,
      platformVariantId: listing.platformVariantId ?? undefined,
    });
  }

  protected async extractByPlatformId(
    _ctx: AdapterContext,
    _listing: KnownListingRef,
  ): Promise<ExtractResult | null> {
    return null;
  }

  // ── Belso kereso (spec 14.1/F) ──────────────────────────────────────────
  async search(ctx: AdapterContext, query: SearchQuery): Promise<SearchResult> {
    const cfg = this.config(ctx);
    if (!cfg.searchUrlTemplate) {
      return { status: 'unavailable', targets: [], diagnostics: { adapterKey: this.key, adapterVersion: this.version } };
    }
    const url = cfg.searchUrlTemplate.replace('{query}', encodeURIComponent(query.text));
    const res = await ctx.fetch(url).catch(() => null);
    if (!res?.ok || res.guard.blocked) {
      return {
        status: res?.guard.blocked ? 'blocked' : 'unavailable',
        targets: [],
        diagnostics: { adapterKey: this.key, adapterVersion: this.version },
      };
    }
    const links = extractProductLinks(res.body, res.finalUrl, cfg).slice(0, query.limit ?? 25);
    return {
      status: 'ok',
      targets: links.map((l) => ({ url: canonicalizeUrl(l, cfg.urlRule) })),
      diagnostics: { adapterKey: this.key, adapterVersion: this.version, pagesSeen: 1 },
    };
  }

  // ── Segedek ─────────────────────────────────────────────────────────────
  protected async resolveSitemapUrls(ctx: AdapterContext): Promise<string[]> {
    const cfg = this.config(ctx);
    if (cfg.sitemapUrls?.length) return cfg.sitemapUrls;

    const found: string[] = [];
    const robotsUrl = new URL('/robots.txt', ctx.shop.baseUrl).toString();
    const robots = await ctx.fetch(robotsUrl).catch(() => null);
    if (robots?.ok) {
      found.push(...sitemapsFromRobots(robots.body));
    }
    if (found.length) return found;

    for (const path of DEFAULT_SITEMAP_PATHS) {
      const candidate = new URL(path, ctx.shop.baseUrl).toString();
      const res = await ctx.fetch(candidate).catch(() => null);
      if (res?.ok && !res.guard.blocked && /<(?:urlset|sitemapindex)\b/i.test(res.body)) {
        found.push(candidate);
        break;
      }
    }
    return found;
  }
}

// ── Kozos segedfuggvenyek ───────────────────────────────────────────────────

export function detectPlatform(html: string): string | undefined {
  if (/cdn\.shopify\.com|Shopify\.theme|shopify-section/i.test(html)) return 'shopify';
  if (/wp-content\/plugins\/woocommerce|woocommerce-page|wc-ajax/i.test(html)) return 'woocommerce';
  if (/\/wp-content\/|wp-json/i.test(html)) return 'wordpress';
  if (/Magento|mage\/|static\/version/i.test(html)) return 'magento';
  if (/unas\.hu|UNAS/i.test(html)) return 'unas';
  if (/shoprenter/i.test(html)) return 'shoprenter';
  if (/__NUXT__/i.test(html)) return 'nuxt';
  if (/__NEXT_DATA__/i.test(html)) return 'next';
  return undefined;
}

export function extractProductLinks(html: string, baseUrl: string, cfg: AdapterConfig): string[] {
  const out = new Set<string>();
  const re = /<a\b[^>]*href\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
  let m: RegExpExecArray | null;
  let host: string;
  try { host = new URL(baseUrl).hostname; } catch { return []; }

  while ((m = re.exec(html)) !== null) {
    const href = m[1] ?? m[2] ?? '';
    if (!href || href.startsWith('#') || href.startsWith('javascript:') || href.startsWith('mailto:')) continue;
    let abs: string;
    try { abs = new URL(href, baseUrl).toString(); } catch { continue; }
    try { if (new URL(abs).hostname !== host) continue; } catch { continue; }
    if (!looksLikeProductUrl(abs, { include: cfg.productUrlInclude, exclude: cfg.productUrlExclude })) continue;
    out.add(abs);
  }
  return [...out];
}

function hashUrls(urls: string[]): string {
  let h = 0x811c9dc5;
  for (const u of [...urls].sort()) {
    for (let i = 0; i < u.length; i++) h = Math.imul(h ^ u.charCodeAt(i), 0x01000193) >>> 0;
  }
  return `${h.toString(16)}-${urls.length}`;
}

function numberOrNull(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const n = Number.parseInt(v, 10);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

export type { NormalizedSourceListing };
