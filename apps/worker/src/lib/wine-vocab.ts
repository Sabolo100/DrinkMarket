/**
 * A bor-szotar betoltese az adatbazisbol a slot-kitolteses parserhez.
 *
 * A `@radovin/domain` szandekosan nem ismer adatbazist - a szotarsorok
 * beolvasasa ezert itt tortenik, es innen kap a parser egy kesz indexet.
 *
 * Minden entitas KETSZER kerul be: egyszer a kanonikus neven, egyszer minden
 * jovahagyott aliaszan. A parser leghosszabb-egyezes-eloszor dolgozik, ezert
 * a tobbszavas aliasok (pl. "olasz rizling") elonyt elveznek a rovidebb
 * talalatokkal szemben.
 */
import { query } from '@radovin/db';
import { buildWineVocabulary, type VocabRow, type WineVocabulary } from '@radovin/domain';

interface VocabDbRow {
  id: string;
  slot: VocabRow['slot'];
  canonical_name: string;
  phrase: string;
  via_alias: string | null;
  producer_id: string | null;
}

/**
 * Csak JOVAHAGYOTT es AKTIV aliasokat toltunk be. A javasolt (approved =
 * false) sorok szandekosan kimaradnak: azok emberi dontesre varnak, es amig
 * nincs jovahagyva, nem befolyasolhatjak az azonossagot.
 */
const VOCAB_SQL = `
  -- borászatok
  SELECT p.id::text, 'producer' AS slot, p.canonical_name, p.canonical_name AS phrase,
         NULL::text AS via_alias, NULL::text AS producer_id
    FROM producers p WHERE p.status = 'active'
  UNION ALL
  SELECT p.id::text, 'producer', p.canonical_name, a.alias_text, a.alias_text, NULL
    FROM aliases a JOIN producers p ON p.id = a.target_id
   WHERE a.alias_type = 'producer' AND a.approved AND a.active AND p.status = 'active'

  -- szolofajtak
  UNION ALL
  SELECT g.id::text, 'grape', g.canonical_name, g.canonical_name, NULL, NULL
    FROM grape_varieties g WHERE g.status = 'active'
  UNION ALL
  SELECT g.id::text, 'grape', g.canonical_name, a.alias_text, a.alias_text, NULL
    FROM aliases a JOIN grape_varieties g ON g.id = a.target_id
   WHERE a.alias_type = 'grape' AND a.approved AND a.active AND g.status = 'active'

  -- bortipusok
  UNION ALL
  SELECT s.id::text, 'style', s.canonical_name, s.canonical_name, NULL, NULL
    FROM wine_styles s WHERE s.status = 'active'
  UNION ALL
  SELECT s.id::text, 'style', s.canonical_name, a.alias_text, a.alias_text, NULL
    FROM aliases a JOIN wine_styles s ON s.id = a.target_id
   WHERE a.alias_type = 'wine_style' AND a.approved AND a.active AND s.status = 'active'

  -- borvidekek
  UNION ALL
  SELECT r.id::text, 'region', r.canonical_name, r.canonical_name, NULL, NULL
    FROM wine_regions r WHERE r.status = 'active'
  UNION ALL
  SELECT r.id::text, 'region', r.canonical_name, a.alias_text, a.alias_text, NULL
    FROM aliases a JOIN wine_regions r ON r.id = a.target_id
   WHERE a.alias_type = 'wine_region' AND a.approved AND a.active AND r.status = 'active'

  -- dulok (a borászathoz kotottseget a parser ervenyesiti)
  UNION ALL
  SELECT v.id::text, 'vineyard', v.canonical_name, v.canonical_name, NULL, v.producer_id::text
    FROM vineyards v WHERE v.status = 'active'
  UNION ALL
  SELECT v.id::text, 'vineyard', v.canonical_name, a.alias_text, a.alias_text, v.producer_id::text
    FROM aliases a JOIN vineyards v ON v.id = a.target_id
   WHERE a.alias_type = 'vineyard' AND a.approved AND a.active AND v.status = 'active'
`;

export interface LoadedVocabulary {
  vocab: WineVocabulary;
  /** Slotonkenti entitasszam - a riporthoz es a naplozashoz. */
  counts: Record<VocabRow['slot'], number>;
}

export async function loadWineVocabulary(): Promise<LoadedVocabulary> {
  const rows = await query<VocabDbRow>(VOCAB_SQL);
  const vocabRows: VocabRow[] = rows.map((r) => ({
    id: r.id,
    slot: r.slot,
    canonicalName: r.canonical_name,
    phrase: r.phrase,
    viaAlias: r.via_alias,
    producerId: r.producer_id,
  }));

  const counts: Record<VocabRow['slot'], number> = {
    producer: 0, grape: 0, style: 0, region: 0, vineyard: 0,
  };
  const seen = new Set<string>();
  for (const r of vocabRows) {
    const key = `${r.slot}:${r.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    counts[r.slot]++;
  }

  return { vocab: buildWineVocabulary(vocabRows), counts };
}

/**
 * Gyorsitotarazott szotar a BEGYUJTESI utvonalhoz.
 *
 * A `persistListing` listingenkent fut; a szotar listingenkenti betoltese
 * ket-haromezer felesleges lekerdezes lenne futasonkent. A rovid elettartam
 * viszont fontos: egy frissen jovahagyott boraszatnak percekden belul hatnia
 * kell, nem a worker ujrainditasakor.
 */
const VOCAB_TTL_MS = 3 * 60_000;
let cached: { at: number; value: LoadedVocabulary } | null = null;
let inflight: Promise<LoadedVocabulary> | null = null;

export async function loadWineVocabularyCached(): Promise<LoadedVocabulary> {
  if (cached && Date.now() - cached.at < VOCAB_TTL_MS) return cached.value;
  // Egyidejű hivasoknal egyetlen betoltes fusson.
  inflight ??= loadWineVocabulary().then((value) => {
    cached = { at: Date.now(), value };
    inflight = null;
    return value;
  }).catch((err) => { inflight = null; throw err; });
  return inflight;
}

/** Csak teszthez es a manualis alkalmazashoz: a gyorsitotar eldobasa. */
export function resetWineVocabularyCache(): void {
  cached = null;
  inflight = null;
}

/** A szinlevezeteshez kello szotari kiegeszites, ugyanazzal az elettartammal. */
export interface WineColourLookups {
  styleColour: Map<string, string | null>;
  grapeColour: Map<string, string | null>;
  wineCategoryId: string | null;
}
let colourCache: { at: number; value: WineColourLookups } | null = null;

export async function loadWineColoursCached(): Promise<WineColourLookups> {
  if (colourCache && Date.now() - colourCache.at < VOCAB_TTL_MS) return colourCache.value;
  const [styles, grapes, wineCat] = await Promise.all([
    query<{ id: string; colour: string | null }>(
      `SELECT id::text, colour FROM wine_styles WHERE status = 'active'`),
    query<{ id: string; colour_default: string | null }>(
      `SELECT id::text, colour_default FROM grape_varieties WHERE status = 'active'`),
    query<{ id: string }>(`SELECT id::text FROM product_categories WHERE key = 'wine'`),
  ]);
  const value: WineColourLookups = {
    styleColour: new Map(styles.map((s) => [s.id, s.colour])),
    grapeColour: new Map(grapes.map((g) => [g.id, g.colour_default])),
    wineCategoryId: wineCat[0]?.id ?? null,
  };
  colourCache = { at: Date.now(), value };
  return value;
}

/**
 * A bolt szegmense. A borszotart csak bor-bolt listingjere engedjuk ra: egy
 * palinkanev veletlenul is tartalmazhat borvidek-nevet ("Tokaji"), es abbol
 * nem szabad bor-azonossagot csinalni.
 */
const segments = new Map<string, string | null>();

export async function shopSegment(shopId: string): Promise<string | null> {
  if (segments.has(shopId)) return segments.get(shopId) ?? null;
  const rows = await query<{ segment: string | null }>(
    'SELECT segment FROM shops WHERE id = $1', [shopId]);
  const value = rows[0]?.segment ?? null;
  segments.set(shopId, value);
  return value;
}
