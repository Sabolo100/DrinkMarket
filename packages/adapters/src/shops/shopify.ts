/**
 * Shopify adapter (spec 11.2/2).
 *
 * Felderitesi prioritas:
 *   1. /products.json?limit=250&page=N   (nyilvanos katalogus-vegpont)
 *   2. /collections/all/products.json
 *   3. sitemap_products_*.xml
 *
 * Shopify aregyseg: a /products.json a `price` mezot DECIMALIS stringkent adja
 * ("12990.00"), NEM minor unitban. A Storefront/Ajax API viszont centben ad -
 * ezert a minor unit forrasonkent kulon jelolt (spec 12.3).
 *
 * Varianskezelés: MINDEN variant kulon listing, mert kulon eladhato valtozat.
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

interface ShopifyVariant {
  id: number;
  title: string;
  option1?: string | null;
  option2?: string | null;
  option3?: string | null;
  sku?: string | null;
  barcode?: string | null;
  price: string;
  compare_at_price?: string | null;
  available: boolean;
  grams?: number;
  featured_image?: { src?: string } | null;
}

interface ShopifyProduct {
  id: number;
  title: string;
  handle: string;
  body_html?: string;
  vendor?: string;
  product_type?: string;
  tags?: string[] | string;
  variants: ShopifyVariant[];
  images?: Array<{ src?: string }>;
  options?: Array<{ name?: string; values?: string[] }>;
}

export class ShopifyAdapter extends BaseAdapter {
  key = 'shopify';
  version = '2.1.0';
  capabilities = {
    feed: true, platformApi: true, sitemap: true,
    categoryPages: true, internalSearch: true, requiresBrowser: false,
  };

  override async discover(ctx: AdapterContext): Promise<DiscoveryResult> {
    const started = Date.now();
    const diagnostics = emptyDiagnostics(this.key, this.version);
    const cfg = this.config(ctx);
    const targets: DiscoveredTarget[] = [];
    const seen = new Set<string>();
    const completenessEvidence: string[] = [];
    let status: SourceStatus = 'ok';
    let apiWorks = false;
    let productCount = 0;

    const endpoints = ['/products.json', '/collections/all/products.json'];

    for (const endpoint of endpoints) {
      let page = 1;
      let pagesForEndpoint = 0;
      while (page <= 200 && targets.length < ctx.limits.maxUrls) {
        if (Date.now() - started > ctx.limits.maxDurationMs) {
          status = 'partial';
          diagnostics.notes.push('Idokorlat miatt reszleges discovery.');
          break;
        }
        const url = new URL(`${endpoint}?limit=250&page=${page}`, ctx.shop.baseUrl).toString();
        const res = await ctx.fetch(url, { acceptJson: true }).catch(() => null);
        if (!res) break;
        diagnostics.pagesSeen++;

        if (res.guard.blocked) {
          status = res.guard.reason === 'rate_limited' ? 'rate_limited' : 'blocked';
          diagnostics.errors.push({ code: 'API_BLOCKED', message: res.guard.detail ?? res.guard.reason, url });
          break;
        }
        if (!res.ok) break;

        let products: ShopifyProduct[];
        try {
          const parsed = JSON.parse(res.body) as { products?: ShopifyProduct[] };
          products = parsed.products ?? [];
        } catch {
          diagnostics.errors.push({ code: 'API_PARSE', message: 'A products.json valasza nem ervenyes JSON.', url });
          break;
        }
        if (!products.length) break;
        apiWorks = true;
        pagesForEndpoint++;
        productCount += products.length;

        for (const product of products) {
          // MINDEN variant kulon eladhato valtozat -> kulon listing
          for (const variant of product.variants ?? []) {
            const variantUrl = new URL(
              `/products/${product.handle}?variant=${variant.id}`,
              ctx.shop.baseUrl,
            ).toString();
            const canonical = canonicalizeUrl(variantUrl, cfg.urlRule);
            const key = `${product.id}:${variant.id}`;
            if (seen.has(key)) { diagnostics.urlsDuplicate++; continue; }
            seen.add(key);
            targets.push({
              url: canonical,
              platformProductId: String(product.id),
              platformVariantId: String(variant.id),
              inlineListing: this.toListing(ctx, product, variant, canonical),
            });
          }
        }
        page++;
      }
      if (apiWorks && pagesForEndpoint > 0) {
        completenessEvidence.push(`${endpoint}: ${pagesForEndpoint} oldal, ${productCount} termek, ${targets.length} variansa`);
        break;
      }
    }

    if (!apiWorks) {
      diagnostics.notes.push('A products.json nem elerheto, sitemap alapu discovery indul.');
      const fallback = await super.discover(ctx);
      fallback.diagnostics.notes.push(...diagnostics.notes);
      return fallback;
    }

    diagnostics.urlsDiscovered = targets.length;
    diagnostics.durationMs = Date.now() - started;

    return {
      status,
      targets,
      diagnostics,
      completeness: status === 'ok' ? 'complete' : 'partial',
      completenessEvidence,
    };
  }

  protected override async fetchPlatformData(
    ctx: AdapterContext,
    target: DiscoveredTarget,
    _html: string,
  ): Promise<Record<string, unknown> | null> {
    const handle = extractHandle(target.url);
    if (!handle) return null;
    const url = new URL(`/products/${handle}.js`, ctx.shop.baseUrl).toString();
    const res = await ctx.fetch(url, { acceptJson: true }).catch(() => null);
    if (!res?.ok || res.guard.blocked) return null;
    try {
      const product = JSON.parse(res.body) as ShopifyProduct & { price?: number };
      const variantId = target.platformVariantId ?? new URL(target.url).searchParams.get('variant');
      const variant = variantId
        ? product.variants?.find((v) => String(v.id) === String(variantId))
        : product.variants?.[0];
      if (!variant) return null;
      return {
        id: product.id,
        variant_id: variant.id,
        name: `${product.title}${variant.title && variant.title !== 'Default Title' ? ` - ${variant.title}` : ''}`,
        sku: variant.sku,
        barcode: variant.barcode,
        vendor: product.vendor,
        // A /products/{handle}.js CENTBEN ad arat -> minor unit 2
        price: variant.price,
        compare_at_price: variant.compare_at_price,
        currency_minor_unit: 2,
        available: variant.available,
      };
    } catch {
      return null;
    }
  }

  protected override async extractByPlatformId(
    ctx: AdapterContext,
    listing: KnownListingRef,
  ): Promise<ExtractResult | null> {
    const handle = extractHandle(listing.canonicalUrl);
    if (!handle) return null;
    const url = new URL(`/products/${handle}.json`, ctx.shop.baseUrl).toString();
    const res = await ctx.fetch(url, { acceptJson: true }).catch(() => null);
    if (!res) return null;
    if (res.status === 404) {
      return {
        status: 'unavailable',
        diagnostics: {
          adapterKey: this.key, adapterVersion: this.version,
          errors: [{ code: 'HTTP_404', message: 'A termek mar nem letezik.', url }],
        },
        evidence: {},
      };
    }
    if (!res.ok || res.guard.blocked) return null;
    try {
      const parsed = JSON.parse(res.body) as { product?: ShopifyProduct };
      const product = parsed.product;
      if (!product) return null;
      const variant = listing.platformVariantId
        ? product.variants?.find((v) => String(v.id) === listing.platformVariantId)
        : product.variants?.[0];
      if (!variant) {
        return {
          status: 'unavailable',
          diagnostics: {
            adapterKey: this.key, adapterVersion: this.version,
            errors: [{ code: 'VARIANT_GONE', message: `A(z) ${listing.platformVariantId} varians mar nem letezik.`, url }],
          },
          evidence: {},
        };
      }
      const canonical = canonicalizeUrl(
        new URL(`/products/${product.handle}?variant=${variant.id}`, ctx.shop.baseUrl).toString(),
        this.config(ctx).urlRule,
      );
      const normalized = this.toListing(ctx, product, variant, canonical);
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

  private toListing(
    ctx: AdapterContext,
    product: ShopifyProduct,
    variant: ShopifyVariant,
    canonical: string,
  ): NormalizedSourceListing {
    const cfg = this.config(ctx) as AdapterConfig;
    const warnings: string[] = [];

    const variantSuffix = variant.title && variant.title !== 'Default Title' ? ` ${variant.title}` : '';
    const rawName = cleanText(`${product.title}${variantSuffix}`);

    // A /products.json DECIMALIS stringkent adja az arat -> minor unit 0
    const price = emptyPriceSnapshot();
    price.currency = 'HUF';
    price.sourceMinorUnit = 0;
    price.rawPriceValue = variant.price;
    price.currentPriceHuf = toHuf(variant.price, 0);
    const compareAt = toHuf(variant.compare_at_price ?? null, 0);
    if (compareAt !== null && price.currentPriceHuf !== null && compareAt > price.currentPriceHuf) {
      price.regularPriceHuf = compareAt;
      price.salePriceHuf = price.currentPriceHuf;
    } else {
      price.regularPriceHuf = price.currentPriceHuf;
    }
    price.inStock = variant.available;
    price.availabilityRaw = String(variant.available);
    price.vatIncluded = true;

    const specs: Record<string, string> = {};
    (product.options ?? []).forEach((opt, idx) => {
      const value = [variant.option1, variant.option2, variant.option3][idx];
      if (opt.name && value) specs[cleanText(opt.name)] = cleanText(value);
    });
    if (product.product_type) specs['Tipus'] = product.product_type;

    const tags = Array.isArray(product.tags) ? product.tags : (product.tags ?? '').split(',').map((t) => t.trim());
    const categoryPath = [product.product_type, ...tags].filter((t): t is string => Boolean(t));

    const identityResult = extractIdentity({
      name: rawName,
      structured: {
        sku: variant.sku,
        barcode: variant.barcode,
        id: product.id,
        variant_id: variant.id,
        ...(variant.grams ? { grams: variant.grams } : {}),
      },
      specs,
      categoryPath,
      description: stripTags(product.body_html ?? ''),
      url: canonical,
      brandHint: product.vendor ?? null,
      resolveBrand: (ctx.shop.adapterConfig?.['resolveBrand'] as never) ?? undefined,
      resolveProducer: (ctx.shop.adapterConfig?.['resolveProducer'] as never) ?? undefined,
      resolveCategory: (ctx.shop.adapterConfig?.['resolveCategory'] as never) ?? undefined,
    });
    warnings.push(...identityResult.warnings);

    if (variant.sku) identityResult.identity.sku = variant.sku;
    if (variant.barcode) {
      const digits = variant.barcode.replace(/\D/g, '');
      if (digits.length >= 8) identityResult.identity.gtin = digits;
    }

    const evidence = { ...identityResult.evidence };
    evidence['name'] = {
      field: 'name', normalized_value: rawName, raw_value: `${product.title} / ${variant.title}`,
      source_location: 'shopify.products.json.title', source_excerpt: rawName,
      method: 'platform_api', confidence: 0.99, observed_at: new Date().toISOString(),
    };
    evidence['current_price'] = {
      field: 'current_price', normalized_value: price.currentPriceHuf, raw_value: variant.price,
      source_location: 'shopify.products.json.variants.price',
      source_excerpt: `${variant.price} (decimalis string, minor unit: 0)`,
      method: 'platform_api', confidence: 0.99, observed_at: new Date().toISOString(),
    };
    if (variant.barcode) {
      evidence['gtin'] = {
        field: 'gtin', normalized_value: identityResult.identity.gtin, raw_value: variant.barcode,
        source_location: 'shopify.products.json.variants.barcode', source_excerpt: variant.barcode,
        method: 'platform_api', confidence: 0.97, observed_at: new Date().toISOString(),
      };
    }

    const requiredFields = cfg.requiredFields ?? ['expression', 'volumeMl', 'packCount', 'packagingType'];
    const extractionQuality = computeExtractionQuality(evidence, requiredFields, {
      warnings,
      priceAndProductSameVariant: true,
    });

    return {
      shopKey: ctx.shop.key,
      canonicalUrl: canonical,
      urlKey: urlKey(canonical, cfg.urlRule),
      finalUrl: canonical,
      platformProductId: String(product.id),
      platformVariantId: String(variant.id),
      sku: variant.sku ?? null,
      gtin: identityResult.identity.gtin,
      rawName,
      rawBrand: product.vendor ?? null,
      rawCategoryPath: categoryPath,
      imageUrl: variant.featured_image?.src ?? product.images?.[0]?.src ?? null,
      descriptionExcerpt: stripTags(product.body_html ?? '').slice(0, 500) || null,
      identity: identityResult.identity,
      price,
      availabilityStatus: variant.available ? 'in_stock' : 'out_of_stock',
      evidence,
      extractionQuality,
      extractorKey: this.key,
      extractorVersion: this.version,
      extractionMethod: 'platform_api',
      parseWarnings: warnings,
      contentHash: contentHash({ name: rawName, identity: identityResult.identity, available: variant.available }),
      identityHash: identityHash({
        platformProductId: String(product.id),
        platformVariantId: String(variant.id),
        identity: identityResult.identity,
      }),
      sourceFingerprint: sourceFingerprint(rawName, {
        sku: variant.sku, barcode: variant.barcode,
        volume: identityResult.identity.volumeMl,
        vintage: identityResult.identity.vintageValue,
      }),
    };
  }
}

function extractHandle(url: string): string | null {
  try {
    const parts = new URL(url).pathname.split('/').filter(Boolean);
    const idx = parts.indexOf('products');
    return idx >= 0 ? parts[idx + 1] ?? null : null;
  } catch {
    return null;
  }
}

export const shopifyAdapter: ShopAdapter = new ShopifyAdapter();
