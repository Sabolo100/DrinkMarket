/**
 * Bornev slot-kitolteses felbontasa (spec 13.2 kiterjesztese).
 *
 * A korabbi `deriveExpression()` kivonasos logikaval dolgozott: levonta a
 * nevbol azt, amit mar ismert, es ami maradt, azt egyetlen `expression`
 * blobkent kezelte. Ez ket dolgot nem tudott:
 *
 *   1. A boltok MAS SORRENDBEN irjak ugyanazt a bort. A "Sauska Kekfrankos
 *      2019" es a "2019 Sauska Kekfrankos 0,75" ugyanaz a tetel.
 *   2. A fajta, a bortipus, a dulo es a borvidek beleragadt az expression-be,
 *      igy ket bolt kozott a legkisebb megfogalmazasbeli elteres is
 *      kulonbozo expression-t adott.
 *
 * Ez a modul SORRENDFUGGETLENUL, leghosszabb-egyezes-eloszor keresi ki a
 * nevbol a szotarban szereplo elemeket, es csak a MARADEK lesz a fantazianev.
 *
 * A modul nem fuzzy: kizarolag normalizalt, TELJES TOKENHATARON illeszkedo
 * kifejezeseket ismer fel. Az elfogadott nevvaltozatok az aliases tablabol
 * jonnek, auditaltan. A `fuzzy_blocked` jelzo ezert itt nem jatszik szerepet -
 * az az osszehasonlitasnal (comparators.ts) szamit.
 */
import { searchNorm } from '../normalization/text.js';

export type WineSlot = 'producer' | 'vineyard' | 'region' | 'grape' | 'style';

/** A slotok feldolgozasi prioritasa azonos hosszusagu talalatok eseten. */
const SLOT_PRIORITY: Record<WineSlot, number> = {
  producer: 1,
  vineyard: 2,
  region: 3,
  grape: 4,
  style: 5,
};

/** Csak a fajta lehet tobbertekű - egy cuvee tobb fajtabol all. */
const MULTI_VALUED: ReadonlySet<WineSlot> = new Set<WineSlot>(['grape']);

export interface VocabRow {
  id: string;
  slot: WineSlot;
  canonicalName: string;
  /** A felismerendo kifejezes: a kanonikus nev VAGY egy jovahagyott alias. */
  phrase: string;
  /** Ha aliasrol van szo, az eredeti aliasszoveg; kanonikus nevnel null. */
  viaAlias?: string | null;
  /** Dulo eseten a szuloborászat, ha kotott. */
  producerId?: string | null;
}

interface IndexedPhrase extends VocabRow {
  tokens: string[];
}

export interface WineVocabulary {
  /** Elso token -> az azzal kezdodo kifejezesek, hosszusag szerint csokkenoen. */
  readonly byFirstToken: ReadonlyMap<string, readonly IndexedPhrase[]>;
  readonly size: number;
}

/**
 * Szotarindex epitese. A hivo feladata a DB-bol beolvasni a sorokat - ez a
 * csomag szandekosan nem ismer adatbazist.
 */
export function buildWineVocabulary(rows: readonly VocabRow[]): WineVocabulary {
  const byFirstToken = new Map<string, IndexedPhrase[]>();
  for (const row of rows) {
    const norm = searchNorm(row.phrase);
    if (!norm) continue;
    // Ugyanaz a tokenizalas, mint a parse oldalon - kulonben a szotar es a
    // bemenet maskepp darabolna.
    const tokens = norm.split(' ').map(cleanToken).filter(Boolean);
    if (!tokens.length) continue;
    const key = tokens[0]!;
    const entry: IndexedPhrase = { ...row, tokens };
    const bucket = byFirstToken.get(key);
    if (bucket) bucket.push(entry);
    else byFirstToken.set(key, [entry]);
  }
  // Hosszabb kifejezes eloszor: az "olasz rizling" nyerjen a "rizling" ellen.
  for (const bucket of byFirstToken.values()) {
    bucket.sort((a, b) =>
      b.tokens.length - a.tokens.length ||
      SLOT_PRIORITY[a.slot] - SLOT_PRIORITY[b.slot] ||
      a.canonicalName.localeCompare(b.canonicalName));
  }
  let size = 0;
  for (const b of byFirstToken.values()) size += b.length;
  return { byFirstToken, size };
}

export interface SlotMatch {
  slot: WineSlot;
  id: string;
  canonicalName: string;
  /** Ahogy a nevben szerepelt. */
  matchedText: string;
  viaAlias: string | null;
  startToken: number;
  tokenCount: number;
}

export interface WineParseResult {
  producer: SlotMatch | null;
  vineyard: SlotMatch | null;
  region: SlotMatch | null;
  style: SlotMatch | null;
  grapes: SlotMatch[];
  /** Evjarat, ha a nevben szerepelt. */
  vintageValue: number | null;
  /** A maradek: fantazianev es alnevek. Ures maradek eseten null. */
  expression: string | null;
  /** Minden talalat, pozicio szerint - bizonyitekhoz es a felulethez. */
  matches: SlotMatch[];
  /**
   * Tobb kulonbozo talalat egyertekű slotra (pl. ket kulonbozo borászat a
   * nevben). Nem hiba, de emberi donteshez jelzendo.
   */
  ambiguous: SlotMatch[];
  /** A normalizalt bemeneti tokenek - hibakereseshez. */
  tokens: string[];
}

const VINTAGE_RE = /^(?:19|20)\d{2}$/;

/** Kiszereles, darabszam, alkoholfok: kulon mezok, a maradekba nem valok. */
const MEASURE_PATTERNS: RegExp[] = [
  /^\d+(?:[.,]\d+)?(?:ml|cl|dl|l|liter|litre|ltr)$/,
  /^\d+(?:[.,]\d+)?$/,
  /^(?:ml|cl|dl|l|liter|litre|ltr)$/,
  /^\d{1,3}x\d+(?:[.,]\d+)?(?:ml|cl|dl|l)?$/,
  /^\d{1,2}(?:db|palack|uveg)$/,
  /^(?:db|palack|uveg)$/,
  /^\d{1,2}(?:[.,]\d{1,2})?%$/,
  /^%$/,
];

function isMeasureToken(token: string): boolean {
  return MEASURE_PATTERNS.some((re) => re.test(token));
}

/** Szamnak latszo token: vesszo es pont benne jelentest hordoz (0,75). */
const NUMERIC_TOKEN_RE = /^[\d.,%]+$/;

/**
 * A searchNorm szandekosan megtartja a vesszot es a pontot, mert a
 * tizedesjegyekben jelentest hordoznak ("0,75 l"). Szo vegen viszont csak
 * kozpontozas - es enelkul a "Kekfrankos, Sauska" nevbol "kekfrankos," token
 * lenne, ami egyetlen szotari kifejezesre sem illeszkedne. A cuvee-k
 * fajtalistaja jellemzoen vesszos, ezert ez nem szelsoseges eset.
 */
function cleanToken(token: string): string {
  if (NUMERIC_TOKEN_RE.test(token)) return token;
  return token.replace(/^[.,]+/, '').replace(/[.,]+$/, '');
}

export interface ParseOptions {
  /**
   * Ha meg van adva, a dulotalalatok kozul csak az ehhez a borászathoz
   * kototteket (vagy a kotetleneket) fogadjuk el. A felismert borászat
   * automatikusan ide kerul a masodik korben.
   */
  producerId?: string | null;
  /** Kategoria-specifikus zajszavak (product_categories.noise_terms). */
  noiseTerms?: readonly string[];
}

/**
 * Egy bornev felbontasa slotokra.
 *
 * Az algoritmus leghosszabb-egyezes-eloszor halad: minden pozicion a
 * leghosszabb illeszkedo kifejezest fogyasztjuk el. Ezert nem szamit, hogy a
 * bolt milyen sorrendben irta a nev elemeit.
 */
export function parseWineName(
  rawName: string,
  vocab: WineVocabulary,
  opts: ParseOptions = {},
): WineParseResult {
  const norm = searchNorm(rawName) ?? '';
  const tokens = norm.split(' ').map(cleanToken).filter(Boolean);
  const consumed = new Array<boolean>(tokens.length).fill(false);

  const result: WineParseResult = {
    producer: null, vineyard: null, region: null, style: null,
    grapes: [], vintageValue: null, expression: null,
    matches: [], ambiguous: [], tokens,
  };

  // 1. Evjarat, kiszereles, darabszam, alkoholfok kiemelese.
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (VINTAGE_RE.test(t)) {
      // A legelso ertelmes evjaratot vesszuk; tobb ev eseten a tobbi is
      // elfogy, hogy ne szennyezze a fantazianevet.
      if (result.vintageValue === null) result.vintageValue = Number.parseInt(t, 10);
      consumed[i] = true;
      continue;
    }
    if (isMeasureToken(t)) consumed[i] = true;
  }

  // 2. Szotari slotok. Ket kor: az elsoben felismerjuk a borászatot, a
  //    masodikban a hozza kotott dulok is illeszkedhetnek.
  runMatchPass(tokens, consumed, vocab, result, opts.producerId ?? null);
  if (result.producer) {
    runMatchPass(tokens, consumed, vocab, result, result.producer.id);
  }

  // 3. Maradek = fantazianev.
  const noise = new Set((opts.noiseTerms ?? []).map((t) => searchNorm(t) ?? '').filter(Boolean));
  const residue: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    if (consumed[i]) continue;
    const t = tokens[i]!;
    if (noise.has(t)) continue;
    residue.push(t);
  }
  result.expression = residue.length ? residue.join(' ') : null;

  result.matches.sort((a, b) => a.startToken - b.startToken);
  return result;
}

function runMatchPass(
  tokens: string[],
  consumed: boolean[],
  vocab: WineVocabulary,
  result: WineParseResult,
  producerScope: string | null,
): void {
  for (let i = 0; i < tokens.length; i++) {
    if (consumed[i]) continue;
    const bucket = vocab.byFirstToken.get(tokens[i]!);
    if (!bucket) continue;

    for (const cand of bucket) {
      const n = cand.tokens.length;
      if (i + n > tokens.length) continue;
      // A dulo csak a sajat borászatanal (vagy kotetlenul) ervenyes.
      if (cand.slot === 'vineyard' && cand.producerId && cand.producerId !== producerScope) continue;

      let ok = true;
      for (let k = 0; k < n; k++) {
        if (consumed[i + k] || tokens[i + k] !== cand.tokens[k]) { ok = false; break; }
      }
      if (!ok) continue;

      const match: SlotMatch = {
        slot: cand.slot,
        id: cand.id,
        canonicalName: cand.canonicalName,
        matchedText: tokens.slice(i, i + n).join(' '),
        viaAlias: cand.viaAlias ?? null,
        startToken: i,
        tokenCount: n,
      };

      const multi = MULTI_VALUED.has(cand.slot);

      // UGYANAZ az entitas masodszor. Nincs benne ketertelmuseg - a
      // "Torley Brut pezsgo" nevben a `brut` es a `pezsgo` ugyanaz a
      // bortipus -, ezert a tokent EL KELL FOGYASZTANI.
      //
      // Korabban itt egy `continue` allt a fogyasztas elott, tehat a
      // masodik elofordulas bennmaradt a maradekban. A maradek viszont ket
      // helyre megy tovabb: az `expression` mezobe, es a boraszat-banyaszat
      // bemenetere. Az utobbibol lett a baj: a "pezsgo" boraszatjeloltkent
      // jelent meg a listan.
      const sameEntityAgain = multi
        ? result.grapes.some((g) => g.id === cand.id)
        : (slotFilled(result, cand.slot) && slotId(result, cand.slot) === cand.id);
      if (sameEntityAgain) {
        for (let k = 0; k < n; k++) consumed[i + k] = true;
        i += n - 1;
        break;
      }

      if (!multi && slotFilled(result, cand.slot)) {
        // MAS entitas ugyanarra az egyertekű slotra: valodi ketertelmuseg.
        // A tokent NEM fogyasztjuk el, hogy a maradekban lathato maradjon.
        result.ambiguous.push(match);
        continue;
      }

      for (let k = 0; k < n; k++) consumed[i + k] = true;
      assignSlot(result, match);
      result.matches.push(match);
      i += n - 1;
      break;
    }
  }
}

function slotFilled(r: WineParseResult, slot: WineSlot): boolean {
  switch (slot) {
    case 'producer': return r.producer !== null;
    case 'vineyard': return r.vineyard !== null;
    case 'region': return r.region !== null;
    case 'style': return r.style !== null;
    case 'grape': return r.grapes.length > 0;
  }
}

function slotId(r: WineParseResult, slot: WineSlot): string | null {
  switch (slot) {
    case 'producer': return r.producer?.id ?? null;
    case 'vineyard': return r.vineyard?.id ?? null;
    case 'region': return r.region?.id ?? null;
    case 'style': return r.style?.id ?? null;
    case 'grape': return null;
  }
}

function assignSlot(r: WineParseResult, m: SlotMatch): void {
  switch (m.slot) {
    case 'producer': r.producer = m; break;
    case 'vineyard': r.vineyard = m; break;
    case 'region': r.region = m; break;
    case 'style': r.style = m; break;
    case 'grape': r.grapes.push(m); break;
  }
}

/**
 * A rendezett fajtahalmaz stabil lenyomata. Ugyanazt kell adnia, mint az SQL
 * oldali rv_grape_signature(): a kanonikus nevek normalizalt alakja,
 * abece-sorrendben, '+' jellel osszefuzve.
 *
 * Ures halmaz -> null: a "nem tudjuk" es a "bizonyitottan fajta nelkuli" nem
 * mosodhat ossze.
 */
export function grapeSignature(canonicalNames: readonly string[]): string | null {
  const norms = canonicalNames
    .map((n) => searchNorm(n) ?? '')
    .filter(Boolean)
    .sort();
  const unique = [...new Set(norms)];
  return unique.length ? unique.join('+') : null;
}
