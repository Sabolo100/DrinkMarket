/**
 * Egyseges termekkinyeres (spec 12.).
 *
 * Kinyeresi sorrend egy termekoldalon (spec 12.1):
 *   1. platform API/JSON
 *   2. JSON-LD Product / Offer / ProductGroup
 *   3. beagyazott alkalmazas-state
 *   4. meta- es itemprop-mezok
 *   5. specifikacios tablazat
 *   6. vizualis DOM-mezok
 *   7. cim es leiras
 *   8. (opcionalis OCR - csak tamogato bizonyitek)
 *   9. AI-alapu strukturalas, KIZAROLAG bizonyitekkotott modon
 */
import type {
  AvailabilityStatus, EvidenceMap, NormalizedSourceListing,
} from '@radovin/contracts';
import {
  cleanText, computeExtractionQuality, contentHash, extractIdentity,
  identityHash, sourceFingerprint, type ExtractionSource,
} from '@radovin/domain';
import {
  canonicalLink, extractAppState, extractBreadcrumb, extractImage,
  extractSpecTable, metaContent, stripTags, titleText,
} from './html.js';
import { extractJsonLdBreadcrumb, extractJsonLdProduct, type JsonLdProduct } from './jsonld.js';
import { extractPrices } from './price.js';

export const EXTRACTOR_VERSION = '2.1.0';

export interface UnifiedExtractInput {
  shopKey: string;
  url: string;
  finalUrl?: string;
  html?: string;
  /** Platform API valasz (Shopify product/variant, Woo Store API stb.). */
  platform?: Record<string, unknown> | null;
  platformProductId?: string | null;
  platformVariantId?: string | null;
  urlKey: string;
  minorUnitHint?: number;
  /** Taxonomia-feloldok a domain retegbol. */
  resolveBrand?: ExtractionSource['resolveBrand'];
  resolveProducer?: ExtractionSource['resolveProducer'];
  resolveCategory?: ExtractionSource['resolveCategory'];
  /** Az adapter kulcsa, ami a kinyerest inditotta. */
  extractorKey: string;
  /** A kategoria kotelezo mezoi az extraction_quality szamitasahoz. */
  requiredFields?: string[];
}

export interface UnifiedExtractOutput {
  listing: NormalizedSourceListing;
  warnings: string[];
  /** True, ha az oldal nem termekoldal (gyujtoolal, 404, kategoria). */
  notProduct: boolean;
}

const DEFAULT_REQUIRED = ['expression', 'volumeMl', 'packCount', 'packagingType'];

export function extractListing(input: UnifiedExtractInput): UnifiedExtractOutput {
  const html = input.html ?? '';
  const warnings: string[] = [];
  const evidence: EvidenceMap = {};

  // ── 2. JSON-LD ──────────────────────────────────────────────────────────
  const jsonLd: JsonLdProduct | null = html ? extractJsonLdProduct(html) : null;
  // ── 3. app state ────────────────────────────────────────────────────────
  const appState = html ? extractAppState(html) : {};
  // ── 5. spec tabla ───────────────────────────────────────────────────────
  const specs = html ? extractSpecTable(html) : {};
  // Breadcrumb: JSON-LD elsobbseget elvez a DOM-mal szemben
  const breadcrumb = html ? (extractJsonLdBreadcrumb(html).length ? extractJsonLdBreadcrumb(html) : extractBreadcrumb(html)) : [];

  // ── Nev ─────────────────────────────────────────────────────────────────
  const platformName = strOf(input.platform?.['name'] ?? input.platform?.['title']);
  const ogTitle = html ? metaContent(html, (a) => (a['property'] ?? a['name'] ?? '').toLowerCase() === 'og:title') : null;
  const h1 = html ? firstH1(html) : null;
  const rawName = cleanText(platformName ?? jsonLd?.name ?? h1 ?? ogTitle ?? (html ? titleText(html) : null) ?? '');

  if (!rawName) {
    return {
      notProduct: true,
      warnings: ['Nem talalhato terméknev az oldalon - valoszinuleg nem termekoldal.'],
      listing: emptyListing(input),
    };
  }

  if (platformName) {
    evidence['name'] = evi('name', rawName, platformName, 'platform.name', platformName, 'platform_api', 0.98);
  } else if (jsonLd?.name) {
    evidence['name'] = evi('name', rawName, jsonLd.name, 'jsonld.name', jsonLd.name, 'jsonld', 0.95);
  } else if (h1) {
    evidence['name'] = evi('name', rawName, h1, 'dom.h1', h1, 'dom', 0.8);
  } else {
    evidence['name'] = evi('name', rawName, ogTitle ?? '', 'meta.og:title', ogTitle, 'meta', 0.75);
  }

  // ── Azonositok ──────────────────────────────────────────────────────────
  const sku = strOf(input.platform?.['sku']) ?? jsonLd?.sku ?? specs['Cikkszam'] ?? specs['Cikkszám'] ?? null;
  const gtinRaw = strOf(input.platform?.['barcode'] ?? input.platform?.['gtin'])
    ?? jsonLd?.gtin ?? specs['EAN'] ?? specs['Vonalkod'] ?? specs['Vonalkód'] ?? null;
  const gtin = gtinRaw ? gtinRaw.replace(/\D/g, '') || null : null;

  // ── Kep, leiras, kategoria ─────────────────────────────────────────────
  const imageUrl = jsonLd?.image ?? (html ? extractImage(html, input.finalUrl ?? input.url) : null);
  const description = jsonLd?.description
    ?? (html ? metaContent(html, (a) => (a['name'] ?? a['property'] ?? '').toLowerCase() === 'description') : null);

  // ── Identitas ───────────────────────────────────────────────────────────
  const structured: Record<string, unknown> = {
    ...(jsonLd?.additionalProperties ?? {}),
    ...(input.platform ?? {}),
  };
  if (jsonLd?.gtin) structured['gtin'] = jsonLd.gtin;
  if (jsonLd?.sku) structured['sku'] = jsonLd.sku;
  if (gtin) structured['gtin'] = gtin;

  const identityResult = extractIdentity({
    name: rawName,
    structured,
    specs: { ...specs, ...(jsonLd?.additionalProperties ?? {}) },
    categoryPath: breadcrumb.length ? breadcrumb : jsonLd?.category ? [jsonLd.category] : [],
    description: description ?? undefined,
    url: input.finalUrl ?? input.url,
    brandHint: strOf(input.platform?.['vendor']) ?? jsonLd?.brand ?? null,
    resolveBrand: input.resolveBrand,
    resolveProducer: input.resolveProducer,
    resolveCategory: input.resolveCategory,
  });
  warnings.push(...identityResult.warnings);
  Object.assign(evidence, identityResult.evidence);

  if (gtin && !identityResult.identity.gtin) identityResult.identity.gtin = gtin;
  if (sku && !identityResult.identity.sku) identityResult.identity.sku = sku;

  // ── Ar ──────────────────────────────────────────────────────────────────
  const priceResult = extractPrices({
    html,
    jsonLd,
    appState,
    platform: input.platform ?? null,
    minorUnitHint: input.minorUnitHint,
  });
  warnings.push(...priceResult.warnings);
  Object.assign(evidence, priceResult.evidence);

  // ── Nem termekoldal felismerese ─────────────────────────────────────────
  const looksLikeProduct =
    Boolean(jsonLd) || Boolean(input.platform) ||
    priceResult.price.currentPriceHuf !== null ||
    priceResult.price.regularPriceHuf !== null;
  if (!looksLikeProduct) {
    warnings.push('Sem strukturalt termekadat, sem ar nem talalhato - valoszinuleg nem termekoldal.');
  }

  // ── Minoseg ─────────────────────────────────────────────────────────────
  const requiredFields = input.requiredFields ?? DEFAULT_REQUIRED;
  const priceVariantConsistent = checkPriceVariantConsistency(jsonLd, input.platform);
  const extractionQuality = computeExtractionQuality(evidence, requiredFields, {
    warnings,
    priceAndProductSameVariant: priceVariantConsistent,
  });

  const canonicalUrl = (html ? canonicalLink(html) : null) ?? input.url;
  const extractionMethod = input.platform ? 'platform_api' : jsonLd ? 'jsonld' : Object.keys(appState).length ? 'app_state' : 'dom';

  const listing: NormalizedSourceListing = {
    shopKey: input.shopKey,
    canonicalUrl: absolutize(canonicalUrl, input.url),
    urlKey: input.urlKey,
    finalUrl: input.finalUrl ?? input.url,
    platformProductId: input.platformProductId ?? strOf(input.platform?.['id']) ?? jsonLd?.productId ?? null,
    platformVariantId: input.platformVariantId ?? strOf(input.platform?.['variant_id']) ?? null,
    sku,
    gtin,
    rawName,
    rawBrand: strOf(input.platform?.['vendor']) ?? jsonLd?.brand ?? null,
    rawCategoryPath: breadcrumb,
    imageUrl: imageUrl ?? null,
    descriptionExcerpt: description ? stripTags(description).slice(0, 500) : null,
    identity: identityResult.identity,
    price: priceResult.price,
    availabilityStatus: resolveAvailability(priceResult.availabilityStatus, priceResult.price.inStock),
    evidence,
    extractionQuality,
    extractorKey: input.extractorKey,
    extractorVersion: EXTRACTOR_VERSION,
    extractionMethod,
    parseWarnings: warnings,
    contentHash: contentHash({
      name: rawName,
      identity: identityResult.identity,
      availability: priceResult.price.inStock,
    }),
    identityHash: identityHash({
      platformProductId: input.platformProductId ?? null,
      platformVariantId: input.platformVariantId ?? null,
      identity: identityResult.identity,
    }),
    sourceFingerprint: sourceFingerprint(rawName, {
      gtin, sku,
      volume: identityResult.identity.volumeMl,
      vintage: identityResult.identity.vintageValue,
      packaging: identityResult.identity.packagingType,
    }),
    aiUsed: false,
  };

  return { listing, warnings, notProduct: !looksLikeProduct && !rawName };
}

function resolveAvailability(status: AvailabilityStatus, inStock: boolean | null): AvailabilityStatus {
  if (status !== 'unknown') return status;
  if (inStock === true) return 'in_stock';
  if (inStock === false) return 'out_of_stock';
  return 'unknown';
}

/**
 * Ellenorzi, hogy az ar es a termekobjektum UGYANAHHOZ a varianshoz tartozik-e
 * (spec 12.5). Ha a JSON-LD tobb, elteroe aru offert ad varianskijeloles
 * nelkul, az kockazatos.
 */
function checkPriceVariantConsistency(jsonLd: JsonLdProduct | null, platform: Record<string, unknown> | null | undefined): boolean {
  if (platform) return true;
  if (!jsonLd) return true;
  if (jsonLd.variants.length > 1 && jsonLd.offers.length <= 1) return false;
  const prices = new Set(jsonLd.offers.map((o) => o.price).filter((p): p is number => typeof p === 'number'));
  return prices.size <= 1;
}

function firstH1(html: string): string | null {
  const m = html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i);
  return m?.[1] ? stripTags(m[1]) : null;
}

function strOf(v: unknown): string | null {
  if (typeof v === 'string') return v.trim() || null;
  if (typeof v === 'number') return String(v);
  return null;
}

function absolutize(href: string, base: string): string {
  try {
    return new URL(href, base).toString();
  } catch {
    return href;
  }
}

function evi(
  field: string, value: unknown, raw: string | null, location: string,
  excerpt: string | null, method: NormalizedSourceListing['extractionMethod'], confidence: number,
) {
  return {
    field, normalized_value: value, raw_value: raw, source_location: location,
    source_excerpt: excerpt, method, confidence, observed_at: new Date().toISOString(),
  };
}

function emptyListing(input: UnifiedExtractInput): NormalizedSourceListing {
  return {
    shopKey: input.shopKey,
    canonicalUrl: input.url,
    urlKey: input.urlKey,
    finalUrl: input.finalUrl ?? input.url,
    platformProductId: input.platformProductId ?? null,
    platformVariantId: input.platformVariantId ?? null,
    sku: null, gtin: null, rawName: '', rawBrand: null, rawCategoryPath: [],
    imageUrl: null, descriptionExcerpt: null,
    identity: extractIdentity({ name: '' }).identity,
    price: extractPrices({}).price,
    availabilityStatus: 'unknown',
    evidence: {}, extractionQuality: 0,
    extractorKey: input.extractorKey, extractorVersion: EXTRACTOR_VERSION,
    extractionMethod: 'dom', parseWarnings: [],
    contentHash: '', identityHash: '', sourceFingerprint: '',
  };
}
