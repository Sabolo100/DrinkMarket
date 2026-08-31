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
