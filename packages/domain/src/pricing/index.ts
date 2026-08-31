/**
 * Arkezeles: osszehasonlithato ar kivalasztasa, piaci pozicio, anomaliak.
 * Spec 12.3, 18.2 - 18.5.
 */
import type { ComparisonPolicy, PriceSnapshot, PriceType } from '@radovin/contracts';

// ═══════════════════════════════════════════════════════════════════════════
// Ar-konverzio (spec 12.3)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * A forras altal adott ar atvaltasa egesz HUF-ra.
 *
 * FONTOS: a WooCommerce vagy mas platform aregyseget NEM szabad fixen
 * 100-zal osztani. A `currency_minor_unit` alapjan kell konvertalni.
 */
export function toHuf(rawValue: number | string | null | undefined, minorUnit = 0): number | null {
  if (rawValue === null || rawValue === undefined || rawValue === '') return null;
  const n = typeof rawValue === 'number' ? rawValue : parseMoney(String(rawValue));
  if (n === null || !Number.isFinite(n)) return null;
  const divisor = Math.pow(10, Math.max(0, Math.min(6, minorUnit)));
  const huf = n / divisor;
  if (!Number.isFinite(huf)) return null;
  return Math.round(huf);
}

/** Szoveges ar parszolasa. Kezeli a "12 990 Ft", "12.990,-", "12,990" formakat. */
export function parseMoney(text: string): number | null {
  const cleaned = text
    .replace(/[   ]/g, ' ')
    .replace(/(?:huf|ft|forint|,-|€|eur|\$|usd)/gi, '')
    .trim();
  if (!cleaned) return null;

  // Csak szamjegyek, szokoz, pont, vesszo maradhat
  const only = cleaned.replace(/[^\d.,\s-]/g, '').trim();
  if (!only) return null;

  const lastComma = only.lastIndexOf(',');
  const lastDot = only.lastIndexOf('.');
  let normalized: string;

  if (lastComma > -1 && lastDot > -1) {
    // Az utolso az igazi tizedesjel
    const decSep = lastComma > lastDot ? ',' : '.';
    const thouSep = decSep === ',' ? '.' : ',';
    normalized = only.split(thouSep).join('').replace(decSep, '.');
  } else if (lastComma > -1) {
    const after = only.length - lastComma - 1;
    // "12,990" -> ezres elvalaszto; "12,99" -> tizedes
    normalized = after === 3 ? only.split(',').join('') : only.replace(',', '.');
  } else if (lastDot > -1) {
    const after = only.length - lastDot - 1;
    normalized = after === 3 ? only.split('.').join('') : only;
  } else {
    normalized = only;
  }
  normalized = normalized.replace(/\s/g, '');
  const n = Number.parseFloat(normalized);
  return Number.isFinite(n) ? n : null;
}

// ═══════════════════════════════════════════════════════════════════════════
// Osszehasonlithato ar kivalasztasa (spec 18.2)
// ═══════════════════════════════════════════════════════════════════════════

export interface PriceSelectionResult {
  selectedPriceHuf: number | null;
  priceType: PriceType;
  comparable: boolean;
  notComparableReason: string | null;
  onSale: boolean;
}

/**
 * Az osszehasonlitasba alapertelmezesben a minden latogato szamara elerheto,
 * AFA-t tartalmazo, EGY DARABRA vonatkozo aktualis eladasi ar kerul.
 * Klub-, kupon-, mennyisegi vagy kosarfeltetes ar kulon jeloles nelkul NEM
 * hasonlithato mas webshopok normal nyilvanos arahoz.
 */
export function selectComparablePrice(
  price: PriceSnapshot,
  policy: Pick<ComparisonPolicy, 'allowedPriceTypes' | 'requireInStock'>,
): PriceSelectionResult {
  const allowed = new Set<PriceType>(policy.allowedPriceTypes);

  const sale = price.salePriceHuf;
  const regular = price.regularPriceHuf;
  const current = price.currentPriceHuf;

  // Az aktualis eladasi ar az elsodleges. Ha nincs, akkor sale, majd regular.
  let selected: number | null = null;
  let type: PriceType = 'unknown';
  let onSale = false;

  if (current !== null && current > 0) {
    selected = current;
    if (sale !== null && sale > 0 && current === sale && regular !== null && regular > sale) {
      type = 'sale';
      onSale = true;
    } else if (regular !== null && regular > 0 && current < regular) {
      type = 'sale';
      onSale = true;
    } else {
      type = 'regular';
    }
  } else if (sale !== null && sale > 0) {
    selected = sale;
    type = 'sale';
    onSale = true;
  } else if (regular !== null && regular > 0) {
    selected = regular;
    type = 'regular';
  }

  // Nincs nyilvanos ar, de van korlatozott hozzaferesu ar. Ezt megorizzuk a
  // reszletes nezethez, de SOHA nem tesszuk osszehasonlithatova (spec 18.2).
  if (selected === null || selected <= 0) {
    const restricted: Array<[number | null, PriceType, string]> = [
      [price.memberPriceHuf, 'member', 'Csak klub-/tagi ar lathato, ami nem hasonlithato mas webshopok nyilvanos arahoz.'],
      [price.couponPriceHuf, 'coupon', 'Csak kupont igenylo ar lathato.'],
      [price.quantityPriceHuf, 'quantity', 'Csak mennyisegi ar lathato, ami nem egy darabra vonatkozik.'],
    ];
    for (const [value, restrictedType, reason] of restricted) {
      if (value !== null && value > 0) {
        return {
          selectedPriceHuf: value, priceType: restrictedType, comparable: false,
          notComparableReason: reason, onSale: false,
        };
      }
    }
    return {
      selectedPriceHuf: null, priceType: 'unknown', comparable: false,
      notComparableReason: 'Nem sikerult ervenyes, nyilvanos eladasi arat kinyerni.', onSale: false,
    };
  }

  // Listaar es akcios ar felcserelese (spec 18.4).
  // Akkor is parserhiba, ha a forras nem jelezte akciokent.
  if (regular !== null && regular > 0) {
    const saleLike = sale !== null && sale > 0 ? sale : onSale ? selected : null;
    if (saleLike !== null && saleLike > regular) {
      return {
        selectedPriceHuf: null, priceType: 'not_comparable', comparable: false,
        notComparableReason: `Az akcios ar (${saleLike} Ft) magasabb a listaarnal (${regular} Ft) - valoszinu parserhiba.`,
        onSale,
      };
    }
  }

  if (!allowed.has(type)) {
    return {
      selectedPriceHuf: selected, priceType: type, comparable: false,
      notComparableReason: `A(z) "${type}" artipus nem szerepel az engedelyezett osszehasonlitasi artipusok kozott.`, onSale,
    };
  }

  if (policy.requireInStock && price.inStock === false) {
    return {
      selectedPriceHuf: selected, priceType: type, comparable: false,
      notComparableReason: 'A termek nem keszleten van, a policy szerint nem szamit a rangsorba.', onSale,
    };
  }

  return { selectedPriceHuf: selected, priceType: type, comparable: true, notComparableReason: null, onSale };
}

// ═══════════════════════════════════════════════════════════════════════════
// Anomaliadetektalas (spec 18.4)
// ═══════════════════════════════════════════════════════════════════════════

export interface AnomalyConfig {
  significantChangePct: number;
  extremeChangePct: number;
  magnitudeFactor: number;
  minPlausiblePriceHuf: number;
  maxPlausiblePriceHuf: number;
  quarantineOnExtreme: boolean;
}

export const DEFAULT_ANOMALY_CONFIG: AnomalyConfig = {
  significantChangePct: 15,
  extremeChangePct: 60,
  magnitudeFactor: 8,
  minPlausiblePriceHuf: 500,
  maxPlausiblePriceHuf: 8_000_000,
  quarantineOnExtreme: true,
};

export interface AnomalyResult {
  flags: string[];
  quarantine: boolean;
  significance: 'normal' | 'significant' | 'extreme';
  deltaHuf: number | null;
  deltaPct: number | null;
  message: string | null;
}

/**
 * Az anomaliadetektor SOHA nem dob el csendben valodi arvaltozast.
 * A rekord karantenba kerul, bizonyitekkal egyutt.
 */
export function detectPriceAnomaly(
  newPriceHuf: number | null,
  previousPriceHuf: number | null,
  context: {
    unitPriceHuf?: number | null;
    volumeMl?: number | null;
    packCount?: number;
    marketMedianHuf?: number | null;
  } = {},
  config: AnomalyConfig = DEFAULT_ANOMALY_CONFIG,
): AnomalyResult {
  const flags: string[] = [];
  let quarantine = false;
  let significance: AnomalyResult['significance'] = 'normal';
  const messages: string[] = [];

  if (newPriceHuf === null) {
    return { flags: ['NO_PRICE'], quarantine: false, significance: 'normal', deltaHuf: null, deltaPct: null, message: null };
  }
  if (newPriceHuf <= 0) {
    return {
      flags: ['NON_POSITIVE_PRICE'], quarantine: true, significance: 'extreme',
      deltaHuf: null, deltaPct: null, message: 'Nulla vagy negativ ar.',
    };
  }
  if (newPriceHuf < config.minPlausiblePriceHuf) {
    flags.push('IMPLAUSIBLY_LOW');
    messages.push(`Az ar (${newPriceHuf} Ft) irrealisan alacsony - tartozek vagy kostolominta lehet.`);
    quarantine = true;
    significance = 'extreme';
  }
  if (newPriceHuf > config.maxPlausiblePriceHuf) {
    flags.push('IMPLAUSIBLY_HIGH');
    messages.push(`Az ar (${newPriceHuf} Ft) irrealisan magas.`);
    quarantine = true;
    significance = 'extreme';
  }

  // Egysegar es darabar osszekeverese
  if (context.unitPriceHuf && context.volumeMl && context.volumeMl !== 1000) {
    const ratio = newPriceHuf / context.unitPriceHuf;
    const expectedRatio = context.volumeMl / 1000;
    if (Math.abs(ratio - 1) < 0.02 && Math.abs(expectedRatio - 1) > 0.1) {
      flags.push('UNIT_PRICE_CONFUSION');
      messages.push('Az ar megegyezik az egysegarral, pedig a kiszereles nem 1 liter.');
      quarantine = true;
    }
  }

  // Minor unit hiba gyanuja a mediahoz kepest
  if (context.marketMedianHuf && context.marketMedianHuf > 0) {
    const r = newPriceHuf / context.marketMedianHuf;
    if (r >= 90 && r <= 110) {
      flags.push('MINOR_UNIT_SUSPECT_X100');
      messages.push('Az ar kb. szazszorosa a piaci medianak - minor unit hiba gyanuja.');
      quarantine = true;
      significance = 'extreme';
    } else if (r >= 0.009 && r <= 0.011) {
      flags.push('MINOR_UNIT_SUSPECT_DIV100');
      messages.push('Az ar kb. szazad resze a piaci medianak - minor unit hiba gyanuja.');
      quarantine = true;
      significance = 'extreme';
    }
  }

  let deltaHuf: number | null = null;
  let deltaPct: number | null = null;
  if (previousPriceHuf !== null && previousPriceHuf > 0) {
    deltaHuf = newPriceHuf - previousPriceHuf;
    deltaPct = Math.round((deltaHuf / previousPriceHuf) * 10000) / 100;
    const absPct = Math.abs(deltaPct);
    const factor = newPriceHuf / previousPriceHuf;

    if (factor >= config.magnitudeFactor || factor <= 1 / config.magnitudeFactor) {
      flags.push('MAGNITUDE_CHANGE');
      messages.push(`Nagysagrendi arvaltozas (${previousPriceHuf} -> ${newPriceHuf} Ft).`);
      significance = 'extreme';
      if (config.quarantineOnExtreme) quarantine = true;
    } else if (absPct >= config.extremeChangePct) {
      flags.push('EXTREME_CHANGE');
      messages.push(`Extrem arvaltozas: ${deltaPct}%.`);
      significance = 'extreme';
      if (config.quarantineOnExtreme) quarantine = true;
    } else if (absPct >= config.significantChangePct) {
      flags.push('SIGNIFICANT_CHANGE');
      messages.push(`Jelentos arvaltozas: ${deltaPct}%.`);
      if (significance === 'normal') significance = 'significant';
    }
  }

  return {
    flags, quarantine, significance, deltaHuf, deltaPct,
    message: messages.length ? messages.join(' ') : null,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Piaci pozicio (spec 18.5)
// ═══════════════════════════════════════════════════════════════════════════

export interface MarketOfferInput {
  shopId: string;
  listingId: string;
  priceHuf: number;
  observedAt: Date;
  inStock: boolean | null;
  matchStatus: string;
  stale: boolean;
}

export interface MarketPositionResult {
  offerCount: number;
  shopCount: number;
  minPriceHuf: number | null;
  maxPriceHuf: number | null;
  medianPriceHuf: number | null;
  avgPriceHuf: number | null;
  spreadHuf: number | null;
  spreadPct: number | null;
  minShopId: string | null;
  maxShopId: string | null;
  ranks: Map<string, { rank: number; denominator: number; tied: boolean; deltaToMinHuf: number; deltaToMinPct: number; deltaToMedianHuf: number; deltaToMedianPct: number }>;
}

/**
 * Csak `matched`/`verified` es frissessegi szabalyon beluli ajanlat kerulhet
 * a rangsorba. Egy webshoponkent legfeljebb EGY ajanlat szamit.
 */
export function computeMarketPosition(offers: MarketOfferInput[]): MarketPositionResult {
  const valid = offers.filter((o) => !o.stale && o.priceHuf > 0);
  if (valid.length === 0) {
    return {
      offerCount: 0, shopCount: 0, minPriceHuf: null, maxPriceHuf: null,
      medianPriceHuf: null, avgPriceHuf: null, spreadHuf: null, spreadPct: null,
      minShopId: null, maxShopId: null, ranks: new Map(),
    };
  }

  const prices = valid.map((o) => o.priceHuf).sort((a, b) => a - b);
  const min = prices[0]!;
  const max = prices[prices.length - 1]!;
  const median = medianOf(prices);
  const avg = Math.round(prices.reduce((a, b) => a + b, 0) / prices.length);

  const sorted = [...valid].sort((a, b) => a.priceHuf - b.priceHuf);
  const ranks = new Map<string, ReturnType<typeof rankEntry>>();
  let currentRank = 0;
  let lastPrice: number | null = null;
  sorted.forEach((offer, idx) => {
    if (lastPrice === null || offer.priceHuf !== lastPrice) {
      currentRank = idx + 1;
      lastPrice = offer.priceHuf;
    }
    const tied = sorted.filter((o) => o.priceHuf === offer.priceHuf).length > 1;
    ranks.set(offer.shopId, rankEntry(offer.priceHuf, currentRank, valid.length, tied, min, median));
  });

  const minShop = sorted[0]?.shopId ?? null;
  const maxShop = sorted[sorted.length - 1]?.shopId ?? null;

  return {
    offerCount: valid.length,
    shopCount: new Set(valid.map((o) => o.shopId)).size,
    minPriceHuf: min,
    maxPriceHuf: max,
    medianPriceHuf: median,
    avgPriceHuf: avg,
    spreadHuf: max - min,
    spreadPct: min > 0 ? Math.round(((max - min) / min) * 10000) / 100 : null,
    minShopId: minShop,
    maxShopId: maxShop,
    ranks,
  };
}

function rankEntry(price: number, rank: number, denominator: number, tied: boolean, min: number, median: number) {
  return {
    rank,
    denominator,
    tied,
    deltaToMinHuf: price - min,
    deltaToMinPct: min > 0 ? Math.round(((price - min) / min) * 10000) / 100 : 0,
    deltaToMedianHuf: price - median,
    deltaToMedianPct: median > 0 ? Math.round(((price - median) / median) * 10000) / 100 : 0,
  };
}

export function medianOf(sortedPrices: number[]): number {
  const n = sortedPrices.length;
  if (n === 0) return 0;
  const mid = Math.floor(n / 2);
  if (n % 2 === 1) return sortedPrices[mid]!;
  return Math.round(((sortedPrices[mid - 1] ?? 0) + (sortedPrices[mid] ?? 0)) / 2);
}

/** Frissessegi ellenorzes: az adat kora oraban. */
export function freshnessHours(observedAt: Date, now: Date = new Date()): number {
  return Math.round(((now.getTime() - observedAt.getTime()) / 3_600_000) * 100) / 100;
}

export function isStale(observedAt: Date, maxHours: number, now: Date = new Date()): boolean {
  return freshnessHours(observedAt, now) > maxHours;
}
