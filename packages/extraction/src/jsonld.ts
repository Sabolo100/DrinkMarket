/**
 * JSON-LD Product / Offer / ProductGroup kinyeres (spec 12.1/2).
 * Hivatkozas: https://schema.org/Product, https://schema.org/Offer
 */
import { findTags, safeJson } from './html.js';

export interface JsonLdProduct {
  name?: string;
  brand?: string;
  sku?: string;
  mpn?: string;
  gtin?: string;
  description?: string;
  image?: string;
  category?: string;
  productId?: string;
  additionalProperties: Record<string, string>;
  offers: JsonLdOffer[];
  /** Ha ProductGroup: a variansok kulon termekkent. */
  variants: JsonLdProduct[];
  raw: Record<string, unknown>;
}

export interface JsonLdOffer {
  price?: number;
  priceCurrency?: string;
  priceSpecification?: Array<{ price?: number; currency?: string; type?: string; validThrough?: string }>;
  availability?: string;
  itemCondition?: string;
  url?: string;
  sku?: string;
  gtin?: string;
  validFrom?: string;
  validThrough?: string;
  raw: Record<string, unknown>;
}

/** Minden JSON-LD blokk kigyujtese az oldalrol. */
export function collectJsonLd(html: string): unknown[] {
  const blocks: unknown[] = [];
  for (const script of findTags(html, 'script')) {
    const type = (script.attrs['type'] ?? '').toLowerCase();
    if (!type.includes('ld+json')) continue;
    const parsed = safeJson(unescapeJsonLd(script.inner));
    if (parsed === null) continue;
    if (Array.isArray(parsed)) blocks.push(...parsed);
    else blocks.push(parsed);
  }
  // @graph kibontasa
  const flat: unknown[] = [];
  for (const b of blocks) {
    if (b && typeof b === 'object' && '@graph' in (b as Record<string, unknown>)) {
      const graph = (b as Record<string, unknown>)['@graph'];
      if (Array.isArray(graph)) flat.push(...graph);
      else flat.push(b);
    } else {
      flat.push(b);
    }
  }
  return flat;
}

function unescapeJsonLd(text: string): string {
  return text.replace(/<!\[CDATA\[/g, '').replace(/\]\]>/g, '').trim();
}

function typeOf(node: unknown): string[] {
  if (!node || typeof node !== 'object') return [];
  const t = (node as Record<string, unknown>)['@type'];
  if (typeof t === 'string') return [t];
  if (Array.isArray(t)) return t.filter((x): x is string => typeof x === 'string');
  return [];
}

function str(v: unknown): string | undefined {
  if (typeof v === 'string') return v.trim() || undefined;
  if (typeof v === 'number') return String(v);
  return undefined;
}

function num(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const n = Number.parseFloat(v.replace(/\s/g, '').replace(',', '.'));
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

function nameOf(v: unknown): string | undefined {
  if (typeof v === 'string') return v.trim() || undefined;
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return str(o['name']) ?? str(o['@id']);
  }
  return undefined;
}

function imageOf(v: unknown): string | undefined {
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return imageOf(v[0]);
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return str(o['url']) ?? str(o['contentUrl']);
  }
  return undefined;
}

function parseOffer(node: unknown): JsonLdOffer | null {
  if (!node || typeof node !== 'object') return null;
  const o = node as Record<string, unknown>;
  const types = typeOf(node);
  if (types.length && !types.some((t) => /Offer/i.test(t))) return null;

  const specs: JsonLdOffer['priceSpecification'] = [];
  const rawSpec = o['priceSpecification'];
  const specArray = Array.isArray(rawSpec) ? rawSpec : rawSpec ? [rawSpec] : [];
  for (const s of specArray) {
    if (!s || typeof s !== 'object') continue;
    const so = s as Record<string, unknown>;
    specs.push({
      price: num(so['price']),
      currency: str(so['priceCurrency']),
      type: typeOf(s)[0] ?? str(so['@type']),
      validThrough: str(so['validThrough']),
    });
  }

  return {
    price: num(o['price']) ?? num((o['priceSpecification'] as Record<string, unknown>)?.['price']),
    priceCurrency: str(o['priceCurrency']),
    priceSpecification: specs.length ? specs : undefined,
    availability: str(o['availability']),
    itemCondition: str(o['itemCondition']),
    url: str(o['url']),
    sku: str(o['sku']),
    gtin: str(o['gtin13']) ?? str(o['gtin']) ?? str(o['gtin12']) ?? str(o['gtin14']) ?? str(o['gtin8']),
    validFrom: str(o['validFrom']),
    validThrough: str(o['validThrough']),
    raw: o,
  };
}

function parseProduct(node: unknown): JsonLdProduct | null {
  if (!node || typeof node !== 'object') return null;
  const types = typeOf(node);
  if (!types.some((t) => /^(Product|ProductGroup|IndividualProduct|ProductModel)$/i.test(t))) return null;
  const o = node as Record<string, unknown>;

  const offersRaw = o['offers'];
  const offerNodes = Array.isArray(offersRaw) ? offersRaw : offersRaw ? [offersRaw] : [];
  const offers: JsonLdOffer[] = [];
  for (const n of offerNodes) {
    // AggregateOffer eseten a benne levo offereket bontjuk ki
    if (n && typeof n === 'object' && typeOf(n).some((t) => /AggregateOffer/i.test(t))) {
      const inner = (n as Record<string, unknown>)['offers'];
      const innerArr = Array.isArray(inner) ? inner : inner ? [inner] : [];
      for (const i of innerArr) {
        const p = parseOffer(i);
        if (p) offers.push(p);
      }
      const lowPrice = num((n as Record<string, unknown>)['lowPrice']);
      if (!offers.length && lowPrice !== undefined) {
        offers.push({ price: lowPrice, priceCurrency: str((n as Record<string, unknown>)['priceCurrency']), raw: n as Record<string, unknown> });
      }
      continue;
    }
    const p = parseOffer(n);
    if (p) offers.push(p);
  }

  const additional: Record<string, string> = {};
  const props = o['additionalProperty'];
  const propArray = Array.isArray(props) ? props : props ? [props] : [];
  for (const p of propArray) {
    if (!p || typeof p !== 'object') continue;
    const po = p as Record<string, unknown>;
    const key = str(po['name']);
    const value = str(po['value']);
    if (key && value) additional[key] = value;
  }
  for (const key of ['color', 'material', 'size', 'weight', 'depth', 'height', 'width']) {
    const v = o[key];
    const s = typeof v === 'object' && v ? str((v as Record<string, unknown>)['value']) : str(v);
    if (s) additional[key] = s;
  }

  const variants: JsonLdProduct[] = [];
  const hasVariant = o['hasVariant'];
  const variantArray = Array.isArray(hasVariant) ? hasVariant : hasVariant ? [hasVariant] : [];
  for (const v of variantArray) {
    const parsed = parseProduct(v);
    if (parsed) variants.push(parsed);
  }

  return {
    name: str(o['name']),
    brand: nameOf(o['brand']) ?? nameOf(o['manufacturer']),
    sku: str(o['sku']),
    mpn: str(o['mpn']),
    gtin: str(o['gtin13']) ?? str(o['gtin']) ?? str(o['gtin12']) ?? str(o['gtin14']) ?? str(o['gtin8']) ?? str(o['ean']),
    description: str(o['description']),
    image: imageOf(o['image']),
    category: nameOf(o['category']),
    productId: str(o['productID']) ?? str(o['@id']),
    additionalProperties: additional,
    offers,
    variants,
    raw: o,
  };
}

/** Az oldal fo termeke a JSON-LD blokkokbol. */
export function extractJsonLdProduct(html: string): JsonLdProduct | null {
  const blocks = collectJsonLd(html);
  const products: JsonLdProduct[] = [];
  for (const b of blocks) {
    const p = parseProduct(b);
    if (p) products.push(p);
  }
  if (!products.length) return null;
  // A legtobb informaciot tartalmazo termeket valasztjuk
  return products.sort((a, b) => productScore(b) - productScore(a))[0] ?? null;
}

function productScore(p: JsonLdProduct): number {
  let s = 0;
  if (p.name) s += 3;
  if (p.offers.length) s += 3;
  if (p.gtin) s += 2;
  if (p.sku) s += 1;
  if (p.brand) s += 1;
  s += Object.keys(p.additionalProperties).length * 0.2;
  s += p.variants.length * 0.5;
  return s;
}

/** JSON-LD BreadcrumbList kinyerese. */
export function extractJsonLdBreadcrumb(html: string): string[] {
  for (const b of collectJsonLd(html)) {
    if (!typeOf(b).some((t) => /BreadcrumbList/i.test(t))) continue;
    const items = (b as Record<string, unknown>)['itemListElement'];
    if (!Array.isArray(items)) continue;
    const out: string[] = [];
    for (const i of items) {
      if (!i || typeof i !== 'object') continue;
      const io = i as Record<string, unknown>;
      const name = str(io['name']) ?? nameOf(io['item']);
      if (name) out.push(name);
    }
    if (out.length) return out;
  }
  return [];
}

/** Schema.org availability URL -> belso allapot. */
export function mapAvailability(availability: string | undefined): {
  status: 'in_stock' | 'out_of_stock' | 'preorder' | 'backorder' | 'discontinued' | 'unknown';
  inStock: boolean | null;
} {
  if (!availability) return { status: 'unknown', inStock: null };
  const a = availability.toLowerCase();
  if (a.includes('instock') || a.includes('limitedavailability')) return { status: 'in_stock', inStock: true };
  if (a.includes('outofstock') || a.includes('soldout')) return { status: 'out_of_stock', inStock: false };
  if (a.includes('preorder')) return { status: 'preorder', inStock: false };
  if (a.includes('backorder')) return { status: 'backorder', inStock: false };
  if (a.includes('discontinued')) return { status: 'discontinued', inStock: false };
  return { status: 'unknown', inStock: null };
}
