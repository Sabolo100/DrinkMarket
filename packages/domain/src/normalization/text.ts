/**
 * Szovegnormalizalas (spec 13.1).
 *
 * ALAPSZABALY: az eredeti szoveget SOHA nem irjuk felul. A normalizalt forma
 * csak visszakeresesi es osszehasonlitasi reprezentacio.
 *
 * TILOS altalanos stopwordlista (spec 13.2): italoknal a `reserve`, `black`,
 * `dry`, `brut`, `gold` stb. identitast kulonboztet meg.
 */

/** Tipografiai karakterek egysegesitese. Unicode escape, hogy fajlkodolas-fuggetlen legyen. */
const TYPOGRAPHIC_MAP: Record<string, string> = {
  '‘': "'", '’': "'", '‛': "'", 'ʼ': "'",
  '“': '"', '”': '"', '„': '"',
  '–': '-', '—': '-', '−': '-', '‐': '-', '‑': '-',
  ' ': ' ', ' ': ' ', ' ': ' ', ' ': ' ', ' ': ' ',
  '×': 'x', '✕': 'x', '✖': 'x',
  '⁄': '/', '½': ' 1/2 ',
  '​': '', '‌': '', '‍': '', '﻿': '',
};

const TYPOGRAPHIC_RE =
  /[‘’‛ʼ“”„–—−‐‑     ×✕✖⁄½​‌‍﻿]/g;

const HTML_ENTITIES: Record<string, string> = {
  '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'",
  '&apos;': "'", '&nbsp;': ' ', '&ndash;': '-', '&mdash;': '-',
  '&times;': 'x', '&hellip;': '…', '&deg;': '°',
  '&eacute;': 'é', '&aacute;': 'á', '&oacute;': 'ó',
  '&uacute;': 'ú', '&iacute;': 'í', '&ouml;': 'ö',
  '&uuml;': 'ü', '&Ouml;': 'Ö', '&Uuml;': 'Ü',
  '&odblac;': 'ő', '&udblac;': 'ű',
};

export function decodeHtmlEntities(input: string): string {
  return input.replace(/&[a-zA-Z]+;|&#\d+;|&#x[0-9a-fA-F]+;/g, (m) => {
    const known = HTML_ENTITIES[m];
    if (known !== undefined) return known;
    if (m.startsWith('&#x') || m.startsWith('&#X')) {
      const cp = parseInt(m.slice(3, -1), 16);
      return Number.isFinite(cp) ? String.fromCodePoint(cp) : m;
    }
    if (m.startsWith('&#')) {
      const cp = parseInt(m.slice(2, -1), 10);
      return Number.isFinite(cp) ? String.fromCodePoint(cp) : m;
    }
    return m;
  });
}

/** Egysegesitett, de EKEZETES es kisbetusites nelkuli forma. */
export function cleanText(input: string | null | undefined): string {
  if (!input) return '';
  let s = decodeHtmlEntities(String(input)).normalize('NFKC');
  s = s.replace(TYPOGRAPHIC_RE, (c) => TYPOGRAPHIC_MAP[c] ?? c);
  s = s.replace(/<[^>]*>/g, ' ');
  s = s.replace(/\s+/g, ' ').trim();
  return s;
}

/** Ekezetmentesites. Az eredeti megorzendo; ez csak keresesi valtozat. */
export function deaccent(input: string): string {
  return input.normalize('NFD').replace(/[̀-ͯ]/g, '').normalize('NFC');
}

/**
 * Keresesi normalizalas. Meg kell egyeznie a Postgres rv_search_norm()
 * fuggvenyevel, kulonben a jeloltkereses es a JS-oldali osszevetes elter.
 */
export function searchNorm(input: string | null | undefined): string {
  if (!input) return '';
  const cleaned = cleanText(input);
  return deaccent(cleaned)
    .toLowerCase()
    .replace(/[^a-z0-9%.,]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Token lista a normalizalt szovegbol. */
export function tokenize(input: string | null | undefined): string[] {
  const n = searchNorm(input);
  return n ? n.split(' ').filter(Boolean) : [];
}

/**
 * Roviditesek normalizalasa: X.O. -> xo, V.S.O.P. -> vsop (spec 13.1).
 * Csak kontrollalt, ismert mintakra fut - altalanos pontszurest NEM vegzunk.
 */
const ABBREVIATIONS: Array<[RegExp, string]> = [
  [/\bx\s*\.\s*o\s*\.?/gi, 'xo'],
  [/\bv\s*\.\s*s\s*\.\s*o\s*\.\s*p\s*\.?/gi, 'vsop'],
  [/\bv\s*\.\s*s\s*\.(?!\s*o)/gi, 'vs'],
  [/\bn\s*\.\s*v\s*\.?/gi, 'nv'],
  [/\bd\s*\.\s*o\s*\.\s*c\s*\.\s*g\s*\.?/gi, 'docg'],
  [/\bd\s*\.\s*o\s*\.\s*c\s*\.?/gi, 'doc'],
  [/\ba\s*\.\s*o\s*\.\s*c\s*\.?/gi, 'aoc'],
];

export function normalizeAbbreviations(input: string): string {
  let s = input;
  for (const [re, rep] of ABBREVIATIONS) s = s.replace(re, rep);
  return s;
}

/** Teljes keresesi reprezentacio: roviditesek + normalizalas. */
export function retrievalForm(input: string | null | undefined): string {
  if (!input) return '';
  return searchNorm(normalizeAbbreviations(cleanText(input)));
}

/**
 * Kereskedelmi zajszavak eltavolitasa KIZAROLAG a visszakeresesi formabol,
 * kategoriafuggo, verziozott listaval (spec 13.2). A nyers nev erintetlen.
 */
export function stripNoiseTerms(text: string, noiseTerms: readonly string[]): string {
  if (!noiseTerms.length) return text;
  let out = ` ${text} `;
  for (const term of noiseTerms) {
    const t = searchNorm(term);
    if (!t) continue;
    out = out.split(` ${t} `).join(' ');
  }
  return out.replace(/\s+/g, ' ').trim();
}

// -- Hasonlosagi mertekek ---------------------------------------------------

/** Trigram halmaz (a pg_trgm-mel kompatibilis felfogasban). */
export function trigrams(input: string): Set<string> {
  const s = `  ${searchNorm(input)} `;
  const out = new Set<string>();
  for (let i = 0; i + 3 <= s.length; i++) out.add(s.slice(i, i + 3));
  return out;
}

/** Jaccard-alapu trigram hasonlosag, 0..1. */
export function trigramSimilarity(a: string, b: string): number {
  const ta = trigrams(a);
  const tb = trigrams(b);
  if (!ta.size || !tb.size) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  return inter / (ta.size + tb.size - inter);
}

/** Token halmaz Jaccard hasonlosag. */
export function tokenJaccard(a: string, b: string): number {
  const ta = new Set(tokenize(a));
  const tb = new Set(tokenize(b));
  if (!ta.size || !tb.size) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  return inter / (ta.size + tb.size - inter);
}

/** Levenshtein tavolsag (rovid stringekre, markanev-ellenorzeshez). */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev: number[] = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur: number[] = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min((cur[j - 1] ?? 0) + 1, (prev[j] ?? 0) + 1, (prev[j - 1] ?? 0) + cost);
    }
    prev = cur;
  }
  return prev[b.length] ?? 0;
}

export function levenshteinRatio(a: string, b: string): number {
  const x = searchNorm(a);
  const y = searchNorm(b);
  const max = Math.max(x.length, y.length);
  if (!max) return 0;
  return 1 - levenshtein(x, y) / max;
}

/**
 * Tartalmazas-tudatos nevhasonlosag. A rovidebb nev teljes tokenkeszletenek
 * meglete a hosszabbban eros jel (pl. "Gere Roka" a "Gere Roka Pinot Noir 2023"-ban).
 */
export function containmentScore(a: string, b: string): number {
  const ta = tokenize(a);
  const tb = tokenize(b);
  if (!ta.length || !tb.length) return 0;
  const short = ta.length <= tb.length ? ta : tb;
  const long = new Set(ta.length <= tb.length ? tb : ta);
  let hit = 0;
  for (const t of short) if (long.has(t)) hit++;
  return hit / short.length;
}

/** Osszetett nevhasonlosag: trigram + token + tartalmazas sulyozott atlaga. */
export function nameSimilarity(a: string, b: string): number {
  const tri = trigramSimilarity(a, b);
  const tok = tokenJaccard(a, b);
  const con = containmentScore(a, b);
  return 0.4 * tri + 0.35 * tok + 0.25 * con;
}
