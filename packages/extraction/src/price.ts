/**
 * Arkinyeres (spec 12.3).
 *
 * Kulon kell tarolni a normal/lista, aktualis, akcios, klub-, kupon-,
 * mennyisegi es egysegarat, a betetdijat es a keszletallapotot.
 *
 * A WooCommerce vagy mas platform aregyseget NEM szabad fixen 100-zal osztani:
 * a `currency_minor_unit` alapjan kell konvertalni.
 */
import type { AvailabilityStatus, Evidence, EvidenceMap, PriceSnapshot } from '@radovin/contracts';
import { emptyPriceSnapshot } from '@radovin/contracts';
import { parseMoney, toHuf } from '@radovin/domain';
import { findTags, stripTags, metaContent } from './html.js';
import type { JsonLdProduct } from './jsonld.js';
import { mapAvailability } from './jsonld.js';

export interface PriceExtractionInput {
  html?: string;
  jsonLd?: JsonLdProduct | null;
  appState?: Record<string, unknown>;
  /** Platform API valasz (Shopify variant, Woo product stb.). */
  platform?: Record<string, unknown> | null;
  /** A forras altal jelzett minor unit. Ha ismeretlen: 0. */
  minorUnitHint?: number;
  currencyHint?: string;
}

export interface PriceExtractionResult {
  price: PriceSnapshot;
  availabilityStatus: AvailabilityStatus;
  evidence: EvidenceMap;
  warnings: string[];
}

function ev(field: string, value: unknown, raw: string | null, location: string, excerpt: string | null, method: Evidence['method'], confidence: number): Evidence {
  return {
    field, normalized_value: value, raw_value: raw, source_location: location,
    source_excerpt: excerpt, method, confidence, observed_at: new Date().toISOString(),
  };
}

const MEMBER_PRICE_HINTS = /\b(klub|club|tag(?:i|sagi)?|member|torzsvasarlo|hus[eé]g)\b/i;
const COUPON_PRICE_HINTS = /\b(kupon|coupon|kod(?:dal)?|promo\s*kod|voucher)\b/i;
const QUANTITY_PRICE_HINTS = /\b(\d+\s*db\s*felett|mennyisegi|nagyker|karton\s*ar|bulk)\b/i;
const DEPOSIT_HINTS = /\b(betetdij|visszavalt(?:asi)?|uveg\s*betet|deposit)\b/i;
const UNIT_PRICE_HINTS = /\b(egysegar|egyseg\s*ar|\/\s*l\b|\/\s*liter|ft\s*\/\s*l)\b/i;

/**
 * Ar kinyerese a rendelkezesre allo forrasokbol, prioritasi sorrendben:
 * platform API > JSON-LD > app state > DOM.
 */
export function extractPrices(input: PriceExtractionInput): PriceExtractionResult {
  const price = emptyPriceSnapshot();
  const evidence: EvidenceMap = {};
  const warnings: string[] = [];
  let availabilityStatus: AvailabilityStatus = 'unknown';
  price.currency = input.currencyHint ?? 'HUF';

  // ── 1. Platform API ──────────────────────────────────────────────────────
  if (input.platform) {
    const p = input.platform;
    const minorUnit = numberOf(p['currency_minor_unit']) ?? input.minorUnitHint ?? 0;
    price.sourceMinorUnit = minorUnit;

    const regular = toHuf(rawOf(p['regular_price'] ?? p['compare_at_price'] ?? p['list_price']), minorUnit);
    const sale = toHuf(rawOf(p['sale_price']), minorUnit);
    const current = toHuf(rawOf(p['price']), minorUnit);

    if (regular !== null) {
      price.regularPriceHuf = regular;
      evidence['regular_price'] = ev('regular_price', regular, String(p['regular_price'] ?? p['compare_at_price'] ?? ''), 'platform.regular_price', String(p['regular_price'] ?? ''), 'platform_api', 0.97);
    }
    if (sale !== null && sale > 0) {
      price.salePriceHuf = sale;
      evidence['sale_price'] = ev('sale_price', sale, String(p['sale_price']), 'platform.sale_price', String(p['sale_price']), 'platform_api', 0.97);
    }
    if (current !== null) {
      price.currentPriceHuf = current;
      evidence['current_price'] = ev('current_price', current, String(p['price']), 'platform.price', String(p['price']), 'platform_api', 0.98);
    }
    if (typeof p['currency_minor_unit'] !== 'undefined') {
      evidence['currency_minor_unit'] = ev('currency_minor_unit', minorUnit, String(p['currency_minor_unit']), 'platform.currency_minor_unit', String(p['currency_minor_unit']), 'platform_api', 1);
    } else if (input.minorUnitHint === undefined) {
      warnings.push('A platform nem adott currency_minor_unit erteket, 0-t feltetelezunk. Ellenorizni kell.');
    }

    const availableRaw = p['available'] ?? p['in_stock'] ?? p['is_in_stock'] ?? p['stock_status'];
    if (typeof availableRaw === 'boolean') {
      price.inStock = availableRaw;
      availabilityStatus = availableRaw ? 'in_stock' : 'out_of_stock';
    } else if (typeof availableRaw === 'string') {
      const s = availableRaw.toLowerCase();
      price.inStock = s === 'instock' || s === 'in_stock' || s === 'available';
      availabilityStatus = price.inStock ? 'in_stock' : 'out_of_stock';
    }
    if (availableRaw !== undefined && availableRaw !== null) {
      price.availabilityRaw = String(availableRaw);
      evidence['availability'] = ev('availability', price.inStock, String(availableRaw), 'platform.available', String(availableRaw), 'platform_api', 0.95);
    }
  }

  // ── 2. JSON-LD ───────────────────────────────────────────────────────────
  if (input.jsonLd?.offers.length) {
    const offers = input.jsonLd.offers;
    const currencyMatch = offers.filter((o) => !o.priceCurrency || o.priceCurrency.toUpperCase() === price.currency);
    const usable = currencyMatch.length ? currencyMatch : offers;
    const prices = usable.map((o) => o.price).filter((n): n is number => typeof n === 'number' && n > 0);

    if (prices.length && price.currentPriceHuf === null) {
      // Tobb offer eseten a legalacsonyabb NEM feltetlenul helyes: ha tobb
      // varians van, azt kulon listingkent kell kezelni (spec 15.3).
      if (new Set(prices).size > 1) {
        warnings.push(`A JSON-LD tobb, eltero arat tartalmaz (${[...new Set(prices)].join(', ')}) - lehetseges variansproblema.`);
      }
      const chosen = prices[0]!;
      price.currentPriceHuf = Math.round(chosen);
      price.rawPriceValue = String(chosen);
      evidence['current_price'] = ev('current_price', price.currentPriceHuf, String(chosen), 'jsonld.offers.price', String(chosen), 'jsonld', 0.95);
    }

    const spec = usable.flatMap((o) => o.priceSpecification ?? []);
    for (const s of spec) {
      if (!s.price) continue;
      const t = (s.type ?? '').toLowerCase();
      if (t.includes('listprice') || t.includes('strikethrough')) {
        price.regularPriceHuf = price.regularPriceHuf ?? Math.round(s.price);
        evidence['regular_price'] = ev('regular_price', price.regularPriceHuf, String(s.price), 'jsonld.priceSpecification', String(s.price), 'jsonld', 0.9);
      }
    }

    const avail = mapAvailability(usable[0]?.availability);
    if (avail.inStock !== null && price.inStock === null) {
      price.inStock = avail.inStock;
      price.availabilityRaw = usable[0]?.availability ?? null;
      availabilityStatus = avail.status;
      evidence['availability'] = ev('availability', avail.status, usable[0]?.availability ?? null, 'jsonld.offers.availability', usable[0]?.availability ?? null, 'jsonld', 0.93);
    }

    const validFrom = usable[0]?.validFrom;
    const validThrough = usable[0]?.validThrough;
    if (validFrom) price.validFrom = validFrom;
    if (validThrough) price.validTo = validThrough;
  }

  // ── 3. Meta tagek (og:price, product:price) ──────────────────────────────
  if (input.html && price.currentPriceHuf === null) {
    const metaPrice = metaContent(input.html, (a) => {
      const key = (a['property'] ?? a['name'] ?? a['itemprop'] ?? '').toLowerCase();
      return key === 'product:price:amount' || key === 'og:price:amount' || key === 'price';
    });
    if (metaPrice) {
      const parsed = parseMoney(metaPrice);
      if (parsed !== null && parsed > 0) {
        price.currentPriceHuf = Math.round(parsed);
        price.rawPriceValue = metaPrice;
        evidence['current_price'] = ev('current_price', price.currentPriceHuf, metaPrice, 'meta.product:price:amount', metaPrice, 'meta', 0.85);
      }
    }
  }

  // ── 4. DOM (utolso lehetoseg) ────────────────────────────────────────────
  if (input.html) {
    const dom = extractDomPrices(input.html);
    if (price.currentPriceHuf === null && dom.current !== null) {
      price.currentPriceHuf = dom.current;
      price.rawPriceValue = dom.currentRaw;
      evidence['current_price'] = ev('current_price', dom.current, dom.currentRaw, 'dom.price', dom.currentRaw, 'dom', 0.7);
    }
    if (price.regularPriceHuf === null && dom.regular !== null) {
      price.regularPriceHuf = dom.regular;
      evidence['regular_price'] = ev('regular_price', dom.regular, dom.regularRaw, 'dom.regular_price', dom.regularRaw, 'dom', 0.68);
    }
    if (dom.member !== null) {
      price.memberPriceHuf = dom.member;
      evidence['member_price'] = ev('member_price', dom.member, dom.memberRaw, 'dom.member_price', dom.memberRaw, 'dom', 0.65);
    }
    if (dom.coupon !== null) price.couponPriceHuf = dom.coupon;
    if (dom.quantity !== null) price.quantityPriceHuf = dom.quantity;
    if (dom.unit !== null) {
      price.unitPriceHuf = dom.unit;
      price.unitBasis = dom.unitBasis;
      evidence['unit_price'] = ev('unit_price', dom.unit, dom.unitRaw, 'dom.unit_price', dom.unitRaw, 'dom', 0.6);
    }
    if (dom.deposit !== null) price.depositAmountHuf = dom.deposit;
  }

  // ── Ellentmondas-ellenorzes strukturalt vs lathato ar kozott ────────────
  if (input.html && price.currentPriceHuf !== null && evidence['current_price']?.method !== 'dom') {
    const dom = extractDomPrices(input.html);
    if (dom.current !== null && Math.abs(dom.current - price.currentPriceHuf) > Math.max(50, price.currentPriceHuf * 0.02)) {
      warnings.push(`A strukturalt ar (${price.currentPriceHuf} Ft) es a lathato ar (${dom.current} Ft) elter.`);
      price.anomalyFlags.push('STRUCTURED_VS_VISIBLE_PRICE_MISMATCH');
    }
  }

  // AFA: magyar webshopoknal a lakossagi ar alapertelmezesben brutto
  if (price.vatIncluded === null) price.vatIncluded = true;

  return { price, availabilityStatus, evidence, warnings };
}

interface DomPriceResult {
  current: number | null; currentRaw: string | null;
  regular: number | null; regularRaw: string | null;
  member: number | null; memberRaw: string | null;
  coupon: number | null;
  quantity: number | null;
  unit: number | null; unitRaw: string | null; unitBasis: string | null;
  deposit: number | null;
}

const PRICE_TEXT_RE = /(\d[\d\s., ]{1,14})\s*(?:Ft|HUF|forint)\b/gi;

export function extractDomPrices(html: string): DomPriceResult {
  const out: DomPriceResult = {
    current: null, currentRaw: null, regular: null, regularRaw: null,
    member: null, memberRaw: null, coupon: null, quantity: null,
    unit: null, unitRaw: null, unitBasis: null, deposit: null,
  };

  interface Cand { value: number; raw: string; context: string; classes: string; weight: number }
  const candidates: Cand[] = [];

  const priceElements = [
    ...findTags(html, 'span'), ...findTags(html, 'div'),
    ...findTags(html, 'p'), ...findTags(html, 'ins'), ...findTags(html, 'del'), ...findTags(html, 'bdi'),
  ];

  for (const el of priceElements) {
    const classes = `${el.attrs['class'] ?? ''} ${el.attrs['id'] ?? ''} ${el.attrs['itemprop'] ?? ''} ${el.attrs['data-price-type'] ?? ''}`.toLowerCase();
    if (!/price|ar\b|osszeg|amount|cost/.test(classes)) continue;
    const text = stripTags(el.inner);
    if (!text || text.length > 220) continue;
    PRICE_TEXT_RE.lastIndex = 0;
    const m = PRICE_TEXT_RE.exec(text);
    if (!m) continue;
    const value = parseMoney(m[1] ?? '');
    if (value === null || value <= 0) continue;
    candidates.push({
      value: Math.round(value), raw: m[0] ?? '', context: text, classes,
      weight: classifyWeight(classes, text, el.tag),
    });
  }

  if (!candidates.length) {
    // Vegso fallback: a nyers szovegben szereplo elso hihetozo ar
    const text = stripTags(html);
    PRICE_TEXT_RE.lastIndex = 0;
    const m = PRICE_TEXT_RE.exec(text);
    if (m) {
      const value = parseMoney(m[1] ?? '');
      if (value !== null && value >= 200) {
        out.current = Math.round(value);
        out.currentRaw = m[0] ?? null;
      }
    }
    return out;
  }

  for (const c of candidates) {
    const ctx = `${c.classes} ${c.context}`;
    if (DEPOSIT_HINTS.test(ctx)) { out.deposit = out.deposit ?? c.value; continue; }
    if (UNIT_PRICE_HINTS.test(ctx)) {
      out.unit = out.unit ?? c.value;
      out.unitRaw = out.unitRaw ?? c.raw;
      out.unitBasis = /\/\s*l\b|liter/i.test(ctx) ? 'liter' : 'piece';
      continue;
    }
    if (MEMBER_PRICE_HINTS.test(ctx)) { out.member = out.member ?? c.value; out.memberRaw = out.memberRaw ?? c.raw; continue; }
    if (COUPON_PRICE_HINTS.test(ctx)) { out.coupon = out.coupon ?? c.value; continue; }
    if (QUANTITY_PRICE_HINTS.test(ctx)) { out.quantity = out.quantity ?? c.value; continue; }
    if (/\b(del|regi|eredeti|old-price|regular-price|list-price|compare-at|strike|athuzott)\b/i.test(ctx)) {
      if (out.regular === null || c.value > out.regular) { out.regular = c.value; out.regularRaw = c.raw; }
      continue;
    }
    if (out.current === null || c.weight > 0) {
      if (out.current === null) { out.current = c.value; out.currentRaw = c.raw; }
    }
  }

  // Ha van del/ins par: az ins az aktualis, a del a listaar
  const insTags = findTags(html, 'ins');
  const delTags = findTags(html, 'del');
  if (insTags.length && delTags.length) {
    const insPrice = firstPriceIn(insTags.map((t) => stripTags(t.inner)).join(' '));
    const delPrice = firstPriceIn(delTags.map((t) => stripTags(t.inner)).join(' '));
    if (insPrice !== null) { out.current = insPrice; }
    if (delPrice !== null) { out.regular = delPrice; }
  }

  return out;
}

function firstPriceIn(text: string): number | null {
  PRICE_TEXT_RE.lastIndex = 0;
  const m = PRICE_TEXT_RE.exec(text);
  if (!m) return null;
  const v = parseMoney(m[1] ?? '');
  return v !== null && v > 0 ? Math.round(v) : null;
}

function classifyWeight(classes: string, text: string, tag: string): number {
  let w = 0;
  if (/current|sale|special|now|actual|final/.test(classes)) w += 2;
  if (tag === 'ins') w += 2;
  if (tag === 'del') w -= 3;
  if (/old|regular|list|compare|was/.test(classes)) w -= 2;
  if (/product.?price|price.?box|main.?price/.test(classes)) w += 1;
  if (MEMBER_PRICE_HINTS.test(text)) w -= 1;
  return w;
}

function rawOf(v: unknown): number | string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number' || typeof v === 'string') return v;
  return null;
}

function numberOf(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const n = Number.parseInt(v, 10);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}
