/**
 * Mennyiseg-, csomag- es kiszerelesnormalizalas (spec 13.4).
 *
 * A `6 x 0,75 l` NEM alakithato `4,5 l` termekke - az elado egyseg es az ar
 * osszehasonlithatosaga a csomagstrukturatol fugg.
 */
import { cleanText, searchNorm } from './text.js';
import type { PackagingType } from '@radovin/contracts';

export interface VolumeParseResult {
  unitVolumeMl: number | null;
  packCount: number;
  totalVolumeMl: number | null;
  rawMatch: string | null;
  confidence: number;
  method: 'explicit_pack' | 'single_volume' | 'centiliter' | 'liter' | 'none';
}

const UNIT_TO_ML: Record<string, number> = {
  ml: 1, milliliter: 1, mL: 1,
  cl: 10, centiliter: 10,
  dl: 100, deciliter: 100,
  l: 1000, lit: 1000, liter: 1000, litre: 1000, ltr: 1000,
};

/** Szamszoveg -> szam. Elfogadja a "0,75" es "0.75" formatumot is. */
export function parseDecimal(text: string): number | null {
  const t = text.replace(/\s/g, '').replace(',', '.');
  const n = Number.parseFloat(t);
  return Number.isFinite(n) ? n : null;
}

/**
 * Kiszereles es darabszam kinyerese szovegbol.
 * Peldak:
 *   "0,75 l"        -> 750 ml, pack 1
 *   "70 cl"         -> 700 ml, pack 1
 *   "6x0,75 l"      -> 750 ml, pack 6
 *   "karton 6 db"   -> pack 6 (unitVolume ismeretlen)
 *   "1.5L Magnum"   -> 1500 ml, pack 1
 */
export function parseVolume(input: string | null | undefined): VolumeParseResult {
  const empty: VolumeParseResult = {
    unitVolumeMl: null, packCount: 1, totalVolumeMl: null,
    rawMatch: null, confidence: 0, method: 'none',
  };
  if (!input) return empty;
  const text = cleanText(input);
  const norm = text.toLowerCase().replace(/×/g, 'x');

  // 1) Explicit csomag: "6 x 0,75 l", "6x75cl", "6 db x 0.7 l"
  const packRe = /(\d{1,3})\s*(?:db\s*)?x\s*(\d+(?:[.,]\d+)?)\s*(ml|cl|dl|l|liter|litre|ltr)\b/i;
  const packM = norm.match(packRe);
  if (packM) {
    const count = Number.parseInt(packM[1] ?? '', 10);
    const value = parseDecimal(packM[2] ?? '');
    const unit = (packM[3] ?? 'l').toLowerCase();
    const factor = UNIT_TO_ML[unit] ?? UNIT_TO_ML[unit.slice(0, 2)] ?? 1000;
    if (count > 0 && value !== null) {
      const unitMl = Math.round(value * factor);
      return {
        unitVolumeMl: unitMl,
        packCount: count,
        totalVolumeMl: unitMl * count,
        rawMatch: packM[0] ?? null,
        confidence: 0.95,
        method: 'explicit_pack',
      };
    }
  }

  // 2) Forditott sorrend: "0,75 l x 6"
  const packRe2 = /(\d+(?:[.,]\d+)?)\s*(ml|cl|dl|l|liter|litre|ltr)\b\s*x\s*(\d{1,3})\b/i;
  const packM2 = norm.match(packRe2);
  if (packM2) {
    const value = parseDecimal(packM2[1] ?? '');
    const unit = (packM2[2] ?? 'l').toLowerCase();
    const count = Number.parseInt(packM2[3] ?? '', 10);
    const factor = UNIT_TO_ML[unit] ?? 1000;
    if (value !== null && count > 0) {
      const unitMl = Math.round(value * factor);
      return {
        unitVolumeMl: unitMl, packCount: count, totalVolumeMl: unitMl * count,
        rawMatch: packM2[0] ?? null, confidence: 0.92, method: 'explicit_pack',
      };
    }
  }

  // 3) Egyszeru terfogat
  const volRe = /(\d+(?:[.,]\d+)?)\s*(ml|cl|dl|liter|litre|ltr|l)\b/gi;
  let best: { ml: number; raw: string; method: VolumeParseResult['method'] } | null = null;
  for (const m of norm.matchAll(volRe)) {
    const value = parseDecimal(m[1] ?? '');
    const unit = (m[2] ?? '').toLowerCase();
    const factor = UNIT_TO_ML[unit];
    if (value === null || !factor) continue;
    const ml = Math.round(value * factor);
    // Plauzibilitas: 20 ml (mini) - 30 000 ml (nagy formatum)
    if (ml < 20 || ml > 30000) continue;
    const method: VolumeParseResult['method'] =
      unit === 'cl' ? 'centiliter' : unit === 'l' || unit.startsWith('lit') ? 'liter' : 'single_volume';
    if (!best || ml > best.ml) best = { ml, raw: m[0] ?? '', method };
  }

  // 4) Kulon darabszam megjeloles: "karton 6 db", "6 palackos"
  let packCount = 1;
  let packRaw: string | null = null;
  const cartonRe = /\b(?:karton|csomag|doboz|pack|set)\s*(\d{1,2})\s*(?:db|palack|uveg|bottles?)?\b/i;
  const cartonM = norm.match(cartonRe);
  const bottlesRe = /\b(\d{1,2})\s*(?:db|palack|uveg|bottles?|x\s*palack)\b/i;
  const bottlesM = norm.match(bottlesRe);
  if (cartonM?.[1]) {
    packCount = Number.parseInt(cartonM[1], 10);
    packRaw = cartonM[0] ?? null;
  } else if (bottlesM?.[1]) {
    const n = Number.parseInt(bottlesM[1], 10);
    if (n >= 2 && n <= 24) {
      packCount = n;
      packRaw = bottlesM[0] ?? null;
    }
  }

  if (best) {
    return {
      unitVolumeMl: best.ml,
      packCount,
      totalVolumeMl: best.ml * packCount,
      rawMatch: packRaw ? `${best.raw} + ${packRaw}` : best.raw,
      confidence: packCount > 1 ? 0.75 : 0.9,
      method: best.method,
    };
  }
  if (packCount > 1) {
    return { unitVolumeMl: null, packCount, totalVolumeMl: null, rawMatch: packRaw, confidence: 0.5, method: 'explicit_pack' };
  }
  return empty;
}

/** Kiszereles formazasi tolerancia: max 5 ml (spec 15.3). */
export function volumeEquivalent(a: number | null, b: number | null, toleranceMl = 5): boolean {
  if (a === null || b === null) return false;
  return Math.abs(a - b) <= toleranceMl;
}

// -- Csomagolas --------------------------------------------------------------

const PACKAGING_PATTERNS: Array<[RegExp, PackagingType]> = [
  [/\b(fa\s*doboz|fadoboz|wooden\s*(case|box)|fakazetta)\b/i, 'wooden_case'],
  [/\b(disz\s*doboz|diszdoboz|ajandek\s*doboz|ajandekdoboz|gift\s*(box|pack|set)|dd\.|dísz)\b/i, 'gift_box'],
  [/\b(femdoboz|fem\s*doboz|tin\s*box|metal\s*(box|tin))\b/i, 'tin'],
  [/\b(tubus|tube|kartontubus)\b/i, 'tube'],
  [/\b(karton|carton|case\s*of|gyujtokarton)\b/i, 'carton'],
  [/\b(szett|set|csomag\s*ajandek|tasting\s*set|valogatas\s*csomag)\b/i, 'set'],
];

export interface PackagingParseResult {
  packagingType: PackagingType;
  rawMatch: string | null;
  confidence: number;
}

export function parsePackaging(input: string | null | undefined): PackagingParseResult {
  if (!input) return { packagingType: 'unknown', rawMatch: null, confidence: 0 };
  const text = cleanText(input);
  const deaccented = searchNorm(text);
  for (const [re, type] of PACKAGING_PATTERNS) {
    const m = deaccented.match(re) ?? text.match(re);
    if (m) return { packagingType: type, rawMatch: m[0] ?? null, confidence: 0.85 };
  }
  return { packagingType: 'unknown', rawMatch: null, confidence: 0 };
}

/**
 * Csomagolas-ekvivalencia. Alapertelmezesben a diszdoboz NEM azonos eladhato
 * valtozat (spec 3.1). Csak explicit, auditalt policy engedheti.
 */
export function packagingEquivalent(
  a: PackagingType,
  b: PackagingType,
  policy: { giftBoxEquivalent: boolean },
): boolean {
  if (a === b) return true;
  const normalizeStd = (p: PackagingType): PackagingType => (p === 'unknown' ? 'standard' : p);
  const na = normalizeStd(a);
  const nb = normalizeStd(b);
  if (na === nb) return true;
  if (policy.giftBoxEquivalent) {
    const boxy = new Set<PackagingType>(['standard', 'gift_box', 'wooden_case', 'tin', 'tube']);
    return boxy.has(na) && boxy.has(nb);
  }
  return false;
}

// -- Alkoholtartalom ---------------------------------------------------------

export function parseAbv(input: string | null | undefined): { value: number | null; raw: string | null } {
  if (!input) return { value: null, raw: null };
  const text = cleanText(input);
  // A zaro \b szandekosan hianyzik: a '%' nem szo-karakter, ezert a
  // "13,5 %" vegen nem lenne szohatar, es a minta soha nem illeszkedne.
  const m = text.match(/(\d{1,2}(?:[.,]\d{1,2})?)\s*(?:%\s*v\/v|%\s*vol\.?|vol\.?\s*%|%|fok(?![a-z]))/i);
  if (!m) return { value: null, raw: null };
  const v = parseDecimal(m[1] ?? '');
  if (v === null || v < 0 || v > 100) return { value: null, raw: null };
  return { value: v, raw: m[0] ?? null };
}

/**
 * ABV egyenertekuseg. A cimkezesi kerekites miatt 0,15 szazalekpontos
 * tolerancia megengedett; ezen tul kulon valtozatot jelent.
 */
export function abvEquivalent(a: number | null, b: number | null, tolerance = 0.15): boolean {
  if (a === null || b === null) return false;
  return Math.abs(a - b) <= tolerance;
}
