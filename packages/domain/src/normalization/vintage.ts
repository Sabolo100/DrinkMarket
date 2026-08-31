/**
 * Evjarat, korjeloles es kapcsolodo idobeli mezok (spec 13.5).
 *
 * FONTOS: az URL-bol vagy slugbol kinyert ev LEGFELJEBB gyenge jeloltkeresesi
 * informacio. A lathato terméknev, specifikacio es strukturalt adat erosebb.
 * Ellentmondas eseten review szukseges.
 */
import { cleanText, searchNorm } from './text.js';
import type { VintageStatus } from '@radovin/contracts';

const CURRENT_YEAR = new Date().getUTCFullYear();
const MIN_VINTAGE = 1900;
const MAX_VINTAGE = CURRENT_YEAR + 2;

export interface VintageParseResult {
  value: number | null;
  status: VintageStatus;
  rawMatch: string | null;
  confidence: number;
  source: 'name' | 'spec' | 'structured' | 'url' | 'none';
  candidates: number[];
}

const NV_PATTERNS = [
  /\bnon\s*[- ]?\s*vintage\b/i,
  /\bnv\b/i,
  /\bevjarat\s*nelkuli\b/i,
  /\bevjarat\s*nelkul\b/i,
];

/**
 * Evjarat kinyerese szovegbol.
 * A `source` befolyasolja a confidence-t: az URL-bol szarmazo ev gyenge.
 */
export function parseVintage(
  input: string | null | undefined,
  source: VintageParseResult['source'] = 'name',
): VintageParseResult {
  const empty: VintageParseResult = {
    value: null, status: 'unknown', rawMatch: null, confidence: 0, source: 'none', candidates: [],
  };
  if (!input) return empty;
  const text = cleanText(input);
  const norm = searchNorm(text);

  for (const re of NV_PATTERNS) {
    const m = norm.match(re);
    if (m) {
      return {
        value: null, status: 'non_vintage', rawMatch: m[0] ?? null,
        confidence: source === 'url' ? 0.3 : 0.85, source, candidates: [],
      };
    }
  }

  // Evszamok: 4 jegyu, plauzibilis tartomanyban
  const candidates: number[] = [];
  let rawMatch: string | null = null;
  for (const m of text.matchAll(/\b(19\d{2}|20\d{2})\b/g)) {
    const y = Number.parseInt(m[1] ?? '', 10);
    if (y >= MIN_VINTAGE && y <= MAX_VINTAGE) {
      candidates.push(y);
      if (rawMatch === null) rawMatch = m[0] ?? null;
    }
  }

  // Kizarasok: nem evjarat, hanem korjeloles vagy alapitasi ev
  const filtered = candidates.filter((y) => {
    const idx = text.indexOf(String(y));
    const around = text.slice(Math.max(0, idx - 22), idx + 26).toLowerCase();
    if (/\b(est|estd|established|alapitva|since|ota|founded|anno)\b/i.test(around)) return false;
    if (/\b(cikkszam|sku|art\.?\s*nr|cikksz)\b/i.test(around)) return false;
    return true;
  });

  if (filtered.length === 0) return { ...empty, source };
  const unique = [...new Set(filtered)];
  if (unique.length > 1) {
    // Tobb evszam: nem bizonyithato egyertelmuen -> unknown + review jelzes
    return {
      value: null, status: 'unknown', rawMatch,
      confidence: 0, source, candidates: unique,
    };
  }
  const value = unique[0] ?? null;
  const baseConfidence =
    source === 'structured' ? 0.98 : source === 'spec' ? 0.92 : source === 'name' ? 0.85 : 0.25;
  return { value, status: 'vintage', rawMatch, confidence: baseConfidence, source, candidates: unique };
}

// -- Korjeloles (age statement) ---------------------------------------------

export interface AgeParseResult {
  years: number | null;
  rawMatch: string | null;
  confidence: number;
}

export function parseAgeStatement(input: string | null | undefined): AgeParseResult {
  if (!input) return { years: null, rawMatch: null, confidence: 0 };
  const text = cleanText(input);
  const patterns: RegExp[] = [
    /\b(\d{1,2})\s*(?:years?\s*old|yo|y\.o\.|year)\b/i,
    /\b(\d{1,2})\s*(?:eves|ev)\b/i,
    /\b(\d{1,2})\s*(?:ans|anos|anni|jahre)\b/i,
    /\baged\s*(\d{1,2})\b/i,
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (m?.[1]) {
      const y = Number.parseInt(m[1], 10);
      if (y >= 1 && y <= 100) return { years: y, rawMatch: m[0] ?? null, confidence: 0.9 };
    }
  }
  // Onallo szam kozvetlenul a markanev utan (pl. "Glenfiddich 12") - gyengebb jel
  const loose = text.match(/\b(\d{1,2})\s*(?:eves|years?)?\s*(?:$|[|,\-])/i);
  if (loose?.[1]) {
    const y = Number.parseInt(loose[1], 10);
    if ([3, 5, 8, 10, 12, 15, 16, 18, 21, 23, 25, 30, 40, 50].includes(y)) {
      return { years: y, rawMatch: loose[0] ?? null, confidence: 0.55 };
    }
  }
  return { years: null, rawMatch: null, confidence: 0 };
}

/** Puttonyszam (tokaji aszu). 5 es 6 puttonyos NEM azonos (spec 3.1). */
export function parsePuttony(input: string | null | undefined): { value: number | null; rawMatch: string | null } {
  if (!input) return { value: null, rawMatch: null };
  const norm = searchNorm(input);
  const m = norm.match(/\b([3-6])\s*(?:puttonyos|puttony|putt|put)\b/);
  if (m?.[1]) return { value: Number.parseInt(m[1], 10), rawMatch: m[0] ?? null };
  const m2 = norm.match(/\bputtonyos\s*([3-6])\b/);
  if (m2?.[1]) return { value: Number.parseInt(m2[1], 10), rawMatch: m2[0] ?? null };
  return { value: null, rawMatch: null };
}

/**
 * Evjarat-ellentmondas ellenorzese ket oldal kozott.
 * Az `unknown` NEM egyezes, de nem is automatikus ellentmondas (spec 15.2).
 */
export function vintageContradiction(
  left: { value: number | null; status: VintageStatus },
  right: { value: number | null; status: VintageStatus },
): { contradiction: boolean; code?: string } {
  const known = (s: VintageStatus) => s === 'vintage' || s === 'non_vintage';
  if (!known(left.status) || !known(right.status)) return { contradiction: false };
  if (left.status === 'non_vintage' && right.status === 'non_vintage') return { contradiction: false };
  if (left.status !== right.status) return { contradiction: true, code: 'VINTAGE_NV_CONFLICT' };
  if (left.value !== null && right.value !== null && left.value !== right.value) {
    return { contradiction: true, code: 'VINTAGE_MISMATCH' };
  }
  return { contradiction: false };
}
