/**
 * WooCommerce adapter (spec 11.2/2).
 *
 * Felderitesi prioritas:
 *   1. WooCommerce Store API  /wp-json/wc/store/v1/products  (nyilvanos, olvasas)
 *   2. WP REST product feed   /wp-json/wp/v2/product
 *   3. Termek sitemap
 *
 * KRITIKUS (spec 12.3, 32.2): a Store API `prices` objektuma a
 * `currency_minor_unit` szerint skalazott EGESZ szamot ad. Fixen 100-zal
 * osztani HIBA - HUF eseten a minor unit tipikusan 0.
 */
import type {
  AdapterContext, DiscoveredTarget, DiscoveryResult, ExtractResult,
  KnownListingRef, NormalizedSourceListing, ShopAdapter, SourceStatus,
} from '@radovin/contracts';
import { emptyDiagnostics, emptyPriceSnapshot } from '@radovin/contracts';
import {
  cleanText, computeExtractionQuality, contentHash, extractIdentity,
  identityHash, sourceFingerprint, toHuf,
} from '@radovin/domain';
import { canonicalizeUrl, urlKey } from '@radovin/crawler-core';
import { stripTags } from '@radovin/extraction';
import { BaseAdapter, type AdapterConfig } from '../common/base.js';

interface WooStoreProduct {
  id: number;
  name: string;
  slug: string;
  permalink: string;
  sku?: string;
  type?: string;
  variation?: string;
  description?: string;
  short_description?: string;
  is_in_stock?: boolean;
  is_purchasable?: boolean;
  prices?: {
    price?: string;
    regular_price?: string;
    sale_price?: string;
    currency_code?: string;
    currency_minor_unit?: number;
    currency_symbol?: string;
  };
  images?: Array<{ src?: string; thumbnail?: string }>;
  categories?: Array<{ name?: string; slug?: string }>;
  attributes?: Array<{ name?: string; taxonomy?: string; terms?: Array<{ name?: string }> }>;
  variations?: Array<{ id: number; attributes?: Array<{ name?: string; value?: string }> }>;
  extensions?: Record<string, unknown>;
}

export class WooCommerceAdapter extends BaseAdapter {
  key = 'woocommerce';
  version = '2.1.0';
  capabilities = {
    feed: false, platformApi: true, sitemap: true,
    categoryPages: true, internalSearch: true, requiresBrowser: false,
  };

  private storeApiUrl(ctx: AdapterContext, page: number, perPage = 100): string {
    return new URL(
      `/wp-json/wc/store/v1/products?per_page=${perPage}&page=${page}&orderby=id&order=asc`,
      ctx.shop.baseUrl,
    ).toString();
  }

  override async discover(ctx: AdapterContext): Promise<DiscoveryResult> {
    const started = Date.now();
    const diagnostics = emptyDiagnostics(this.key, this.version);
    const cfg = this.config(ctx);
    const targets: DiscoveredTarget[] = [];
    const seen = new Set<string>();
    const completenessEvidence: string[] = [];
    let status: SourceStatus = 'ok';
    let totalReported: number | null = null;

    // ── 1. Store API ────────────────────────────────────────────────────────
    let page = 1;
    let apiWorks = false;
    while (page <= 200 && targets.length < ctx.limits.maxUrls) {
      if (Date.now() - started > ctx.limits.maxDurationMs) {
        status = 'partial';
        diagnostics.notes.push('Idokorlat miatt reszleges discovery.');
        break;
      }
      const url = this.storeApiUrl(ctx, page);
      const res = await ctx.fetch(url, { acceptJson: true }).catch(() => null);
      if (!res) break;
      diagnostics.pagesSeen++;

      if (res.guard.blocked) {
        status = res.guard.reason === 'rate_limited' ? 'rate_limited' : 'blocked';
        diagnostics.errors.push({ code: 'API_BLOCKED', message: res.guard.detail ?? res.guard.reason, url });
        break;
      }
      if (!res.ok) {
        if (page === 1) diagnostics.notes.push(`A Store API nem elerheto (HTTP ${res.status}), sitemapra valtunk.`);
        break;
      }

      let items: WooStoreProduct[];
      try {
        const parsed = JSON.parse(res.body);
        items = Array.isArray(parsed) ? parsed : [];
      } catch {
        diagnostics.errors.push({ code: 'API_PARSE', message: 'A Store API valasza nem ervenyes JSON.', url });
        break;
      }
      if (!items.length) break;
      apiWorks = true;

      if (page === 1) {
        const total = res.headers['x-wp-total'];
        if (total) totalReported = Number.parseInt(total, 10);
      }

      for (const item of items) {
        if (!item.permalink) continue;
        const canonical = canonicalizeUrl(item.permalink, cfg.urlRule);
        const key = `${item.id}`;
        if (seen.has(key)) { diagnostics.urlsDuplicate++; continue; }
        seen.add(key);
        targets.push({
          url: canonical,
          platformProductId: String(item.id),
          inlineListing: this.toListing(ctx, item, canonical),
        });
      }
      page++;
    }

    if (apiWorks) {
      completenessEvidence.push(
        `WooCommerce Store API: ${targets.length} termek${totalReported !== null ? ` (X-WP-Total: ${totalReported})` : ''}`,
      );
      diagnostics.notes.push('Strukturalt platform API hasznalva - nincs szukseg DOM-szelektorra.');
    } else {
      // ── 2. Sitemap fallback ──────────────────────────────────────────────
      diagnostics.notes.push('A Store API nem elerheto, sitemap alapu discovery indul.');
      const fallback = await super.discover(ctx);
      fallback.diagnostics.notes.push(...diagnostics.notes);
      fallback.diagnostics.errors.push(...diagnostics.errors);
      return fallback;
    }

    diagnostics.urlsDiscovered = targets.length;
    diagnostics.durationMs = Date.now() - started;

    const completeness: DiscoveryResult['completeness'] =
      status === 'ok' && totalReported !== null && targets.length >= totalReported ? 'complete'
        : status === 'ok' && totalReported === null ? 'unknown'
          : 'partial';

    return { status, targets, diagnostics, completeness, completenessEvidence };
  }

  protected override async fetchPlatformData(
    ctx: AdapterContext,
    target: DiscoveredTarget,
    html: string,
  ): Promise<Record<string, unknown> | null> {
    // A DOM-bol kiolvasott product ID-vel lekerjuk a strukturalt adatot
    const idMatch = html.match(/post-(\d+)|"product_id"\s*:\s*"?(\d+)"?|data-product_id="(\d+)"/);
    const id = target.platformProductId ?? idMatch?.[1] ?? idMatch?.[2] ?? idMatch?.[3];
    if (!id) return null;
    const url = new URL(`/wp-json/wc/store/v1/products/${id}`, ctx.shop.baseUrl).toString();
    const res = await ctx.fetch(url, { acceptJson: true }).catch(() => null);
    if (!res?.ok || res.guard.blocked) return null;
    try {
      const product = JSON.parse(res.body) as WooStoreProduct;
      return this.flattenForPricing(product);
    } catch {
      return null;
    }
  }

  protected override async extractByPlatformId(
    ctx: AdapterContext,
    listing: KnownListingRef,
  ): Promise<ExtractResult | null> {
    if (!listing.platformProductId) return null;
    const url = new URL(`/wp-json/wc/store/v1/products/${listing.platformProductId}`, ctx.shop.baseUrl).toString();
    const res = await ctx.fetch(url, { acceptJson: true }).catch(() => null);
    if (!res) return null;
    if (res.status === 404) {
      return {
        status: 'unavailable',
        diagnostics: {
          adapterKey: this.key, adapterVersion: this.version,
          errors: [{ code: 'HTTP_404', message: 'A termek mar nem letezik a Store API-ban.', url }],
        },
        evidence: {},
      };
    }
    if (!res.ok || res.guard.blocked) return null;
    try {
      const product = JSON.parse(res.body) as WooStoreProduct;
      const canonical = canonicalizeUrl(product.permalink ?? listing.canonicalUrl, this.config(ctx).urlRule);
      const normalized = this.toListing(ctx, product, canonical);
      return {
        status: 'ok',
        listing: normalized,
        diagnostics: { adapterKey: this.key, adapterVersion: this.version },
        evidence: normalized.evidence,
      };
    } catch {
      return null;
    }
  }

  /** A Store API termekobjektum -> egyseges listing szerzodes. */
  private toListing(ctx: AdapterContext, item: WooStoreProduct, canonical: string): NormalizedSourceListing {
    const cfg = this.config(ctx) as AdapterConfig;
    const minorUnit = item.prices?.currency_minor_unit ?? cfg.minorUnitHint ?? 0;
    const warnings: string[] = [];

    if (item.prices && item.prices.currency_minor_unit === undefined) {
      warnings.push('A Store API nem adott currency_minor_unit erteket - 0-t feltetelezunk, ellenorizni kell.');
    }

    const price = emptyPriceSnapshot();
    price.currency = item.prices?.currency_code ?? 'HUF';
    price.sourceMinorUnit = minorUnit;
    price.rawPriceValue = item.prices?.price ?? null;
    price.currentPriceHuf = toHuf(item.prices?.price ?? null, minorUnit);
    price.regularPriceHuf = toHuf(item.prices?.regular_price ?? null, minorUnit);
    const sale = toHuf(item.prices?.sale_price ?? null, minorUnit);
    if (sale !== null && price.regularPriceHuf !== null && sale < price.regularPriceHuf) {
      price.salePriceHuf = sale;
    }
    price.inStock = item.is_in_stock ?? null;
    price.availabilityRaw = item.is_in_stock === undefined ? null : String(item.is_in_stock);
    price.vatIncluded = true;

    const specs: Record<string, string> = {};
    for (const attr of item.attributes ?? []) {
      const name = attr.name ?? attr.taxonomy;
      const value = (attr.terms ?? []).map((t) => t.name).filter(Boolean).join(', ');
      if (name && value) specs[cleanText(name)] = cleanText(value);
    }

    const categoryPath = (item.categories ?? []).map((c) => c.name).filter((n): n is string => Boolean(n));

    const identityResult = extractIdentity({
      name: item.name,
      structured: {
        sku: item.sku,
        id: item.id,
        ...(item.extensions ?? {}),
      },
      specs,
      categoryPath,
      description: stripTags(item.short_description ?? item.description ?? ''),
      url: canonical,
      brandHint: specs['Marka'] ?? specs['Márka'] ?? specs['Borászat'] ?? specs['Boraszat'] ?? null,
      resolveBrand: (ctx.shop.adapterConfig?.['resolveBrand'] as never) ?? undefined,
      resolveProducer: (ctx.shop.adapterConfig?.['resolveProducer'] as never) ?? undefined,
      resolveCategory: (ctx.shop.adapterConfig?.['resolveCategory'] as never) ?? undefined,
    });
    warnings.push(...identityResult.warnings);

    if (item.sku) identityResult.identity.sku = item.sku;

    const evidence = { ...identityResult.evidence };
    evidence['name'] = {
      field: 'name', normalized_value: cleanText(item.name), raw_value: item.name,
      source_location: 'wc.store.v1.products.name', source_excerpt: item.name,
      method: 'platform_api', confidence: 0.99, observed_at: new Date().toISOString(),
    };
    if (item.prices?.price !== undefined) {
      evidence['current_price'] = {
        field: 'current_price', normalized_value: price.currentPriceHuf,
        raw_value: item.prices.price,
        source_location: 'wc.store.v1.products.prices.price',
        source_excerpt: `${item.prices.price} (minor unit: ${minorUnit})`,
        method: 'platform_api', confidence: 0.99, observed_at: new Date().toISOString(),
      };
    }

    // Variacios termek: a szulotermeket NEM tekintjuk osszehasonlithatonak,
    // mert az ara tobb varianst fed (spec 15.3).
    const isVariable = item.type === 'variable' && (item.variations?.length ?? 0) > 1;
    if (isVariable) {
      warnings.push(`Variacios termek ${item.variations?.length} varianssal - a szulotermek ara nem egyertelmu.`);
      price.notComparableReason = 'Variacios szulotermek - varianskent kell kezelni.';
    }

    const requiredFields = cfg.requiredFields ?? ['expression', 'volumeMl', 'packCount', 'packagingType'];
    const extractionQuality = computeExtractionQuality(evidence, requiredFields, {
      warnings,
      priceAndProductSameVariant: !isVariable,
    });

    return {
      shopKey: ctx.shop.key,
      canonicalUrl: canonical,
      urlKey: urlKey(canonical, cfg.urlRule),
      finalUrl: canonical,
      platformProductId: String(item.id),
      platformVariantId: null,
      sku: item.sku ?? null,
      gtin: identityResult.identity.gtin,
      rawName: cleanText(item.name),
      rawBrand: identityResult.identity.brand,
      rawCategoryPath: categoryPath,
      imageUrl: item.images?.[0]?.src ?? null,
      descriptionExcerpt: stripTags(item.short_description ?? '').slice(0, 500) || null,
      identity: identityResult.identity,
      price,
      availabilityStatus: item.is_in_stock === true ? 'in_stock' : item.is_in_stock === false ? 'out_of_stock' : 'unknown',
      evidence,
      extractionQuality,
      extractorKey: this.key,
      extractorVersion: this.version,
      extractionMethod: 'platform_api',
      parseWarnings: warnings,
      contentHash: contentHash({ name: item.name, identity: identityResult.identity, stock: item.is_in_stock }),
      identityHash: identityHash({ platformProductId: String(item.id), identity: identityResult.identity }),
      sourceFingerprint: sourceFingerprint(item.name, {
        sku: item.sku, id: item.id,
        volume: identityResult.identity.volumeMl,
        vintage: identityResult.identity.vintageValue,
      }),
    };
  }

  private flattenForPricing(item: WooStoreProduct): Record<string, unknown> {
    return {
      id: item.id,
      name: item.name,
      sku: item.sku,
      price: item.prices?.price,
      regular_price: item.prices?.regular_price,
      sale_price: item.prices?.sale_price,
      currency_minor_unit: item.prices?.currency_minor_unit,
      currency_code: item.prices?.currency_code,
      is_in_stock: item.is_in_stock,
    };
  }
}

export const wooCommerceAdapter: ShopAdapter = new WooCommerceAdapter();
