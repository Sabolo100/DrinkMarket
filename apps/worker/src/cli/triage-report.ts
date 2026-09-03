/**
 * Szarazpróba: mennyit zarna le a gep, es mennyi maradna emberre?
 *
 * A hármas szuro hozama NEM a szabalyon mulik, hanem a kinyeres
 * teljessegen. Ha keves listingen van meg minden azonossagmezo, akkor az
 * automatika keveset zar le - es ilyenkor NEM a kuszobot kell lazitani
 * (az hamis parokat termelne), hanem a kinyeres hianyat javitani, vagy
 * tudatosan kivenni egy mezot az azonossagmagbol.
 *
 * Ezert fut ez a parancs a kapcsolo bekapcsolasa ELOTT. Semmit nem ir.
 *
 * Fejlesztoi gepen `npm run match:triage`, a futtato konteneren
 * `npm run ops:triage` - ott nincs `tsx`, mert a runtime image
 * `--omit=dev`-vel epul, es a `tsx` fejlesztoi fuggoseg.
 */
import { closeDb, initDb, query } from '@radovin/db';
import { configureLogger } from '@radovin/observability';

/**
 * Azonossagmag-mezo -> (bizonyitott-e, mi szerint csoportosit).
 *
 * A magot NEM itt allitjuk ossze, hanem az ADATBAZISBOL olvassuk
 * (`product_categories.identity_profile -> identity_core`). Ha itt
 * masodpeldany lenne, egy migracio csendben szetvinne a riportot es a
 * motort - a riport pedig eppen az a szam, ami alapjan dontesz. Egy ilyen
 * elteres a legrosszabb fajta hiba: sokaig lathatatlan marad.
 */
interface FieldDef {
  /** Bizonyitottnak szamit-e a mezo ezen a listingen. */
  proven: string;
  /** Mi szerint csoportosuljon a "ugyanaz a termek" kulcs. */
  group: string;
  hu: string;
}

const FIELDS: Record<string, FieldDef> = {
  producer: { proven: 'sl.producer_id IS NOT NULL', group: 'sl.producer_id', hu: 'boraszat' },
  brand: { proven: 'sl.brand_id IS NOT NULL', group: 'sl.brand_id', hu: 'marka' },
  grape_varieties: { proven: 'sl.grape_signature IS NOT NULL', group: 'sl.grape_signature', hu: 'fajta' },
  colour: { proven: 'sl.colour IS NOT NULL', group: 'sl.colour', hu: 'szin' },
  wine_style: { proven: 'sl.wine_style_id IS NOT NULL', group: 'sl.wine_style_id', hu: 'bortipus' },
  vineyard: { proven: 'sl.vineyard_id IS NOT NULL', group: 'sl.vineyard_id', hu: 'dulo' },
  vintage: {
    proven: "sl.vintage_value IS NOT NULL AND sl.vintage_status = 'vintage'",
    group: 'sl.vintage_value', hu: 'evjarat',
  },
  volume_ml: { proven: 'sl.volume_ml IS NOT NULL', group: 'sl.volume_ml', hu: 'kiszereles' },
  pack_count: { proven: 'sl.pack_count IS NOT NULL', group: 'sl.pack_count', hu: 'darabszam' },
  packaging_type: { proven: 'sl.packaging_type IS NOT NULL', group: 'sl.packaging_type', hu: 'csomagolas' },
  expression: { proven: 'sl.expression IS NOT NULL', group: 'sl.expression', hu: 'fantazianev' },
  age_statement_years: {
    proven: 'sl.age_statement_years IS NOT NULL', group: 'sl.age_statement_years', hu: 'kor',
  },
  puttony: { proven: 'sl.puttony IS NOT NULL', group: 'sl.puttony', hu: 'puttony' },
  dosage_style: { proven: 'sl.dosage_style IS NOT NULL', group: 'sl.dosage_style', hu: 'dosage' },
  edition: { proven: 'sl.edition IS NOT NULL', group: 'sl.edition', hu: 'kiadas' },
  abv_percent: { proven: 'sl.abv_percent IS NOT NULL', group: 'sl.abv_percent', hu: 'alkoholfok' },
  gtin: { proven: 'sl.gtin_normalized IS NOT NULL', group: 'sl.gtin_normalized', hu: 'EAN' },
};

function pct(part: number, total: number): string {
  if (!total) return '  -  ';
  return `${((part / total) * 100).toFixed(1)}%`.padStart(6);
}

function row(label: string, value: number, total?: number): void {
  const v = String(value).padStart(7);
  console.log(`  ${label.padEnd(52)} ${v}${total !== undefined ? '  ' + pct(value, total) : ''}`);
}

async function main(): Promise<void> {
  configureLogger({ level: 'warn', pretty: true, service: 'triage' });
  const url = process.env['DATABASE_URL'];
  if (!url) throw new Error('A DATABASE_URL kornyezeti valtozo kotelezo.');
  initDb({ connectionString: url, max: 4, applicationName: 'radovin-triage' });

  const priceRatioMax = Number(
    (await query<{ v: string }>(
      `SELECT coalesce(value->>'priceRatioMax','2.0') AS v
         FROM settings WHERE key = 'matching.thresholds' AND active`,
    ))[0]?.v ?? 2.0,
  );

  // ── Az azonossagmag az ADATBAZISBOL ────────────────────────────────────
  const coreRow = await query<{ core: string[] | null }>(
    `SELECT identity_profile->'identity_core' AS core
       FROM product_categories WHERE key = 'wine'`,
  );
  const raw = coreRow[0]?.core ?? [];
  const core = raw.filter((f) => FIELDS[f]);
  const unknownFields = raw.filter((f) => !FIELDS[f]);

  if (!core.length) {
    console.log('\n  A bor kategoria azonossagmagja URES - nincs automatikus jovahagyas.\n');
    await closeDb();
    return;
  }
  if (unknownFields.length) {
    console.log(`\n  FIGYELEM: a riport nem ismeri ezt a magmezot: ${unknownFields.join(', ')}\n`);
  }

  const COMPLETE = core.map((f) => `(${FIELDS[f]!.proven})`).join(' AND ');
  const GROUP_COLS = core.map((f) => FIELDS[f]!.group);
  const GROUP_LIST = GROUP_COLS.join(', ');
  const GROUP_NUMS = core.map((_, i) => i + 1).join(',');

  console.log(`\n  Azonossagmag (bor): ${core.map((f) => FIELDS[f]!.hu).join(' + ')}`);

  // ── 1. A kinyeres teljessege ───────────────────────────────────────────
  const slotSelect = core
    .map((f, i) => `count(*) FILTER (WHERE ${FIELDS[f]!.proven})::int AS f${i}`)
    .join(',\n            ');

  const slots = await query<Record<string, number>>(
    `SELECT count(*)::int AS total,
            ${slotSelect},
            count(*) FILTER (WHERE ${COMPLETE})::int AS complete
       FROM source_listings sl
       JOIN product_categories pc ON pc.id = sl.category_id
      WHERE sl.listing_status = 'active' AND pc.key = 'wine'`,
  );
  const s = slots[0] ?? {};
  const total = s['total'] ?? 0;

  console.log('\n══ A BOR-LISTINGEK AZONOSSAGA ═══════════════════════════════════════════\n');
  row('bor kategoriaju aktiv listing', total);
  console.log();
  core.forEach((f, i) => row(`van ${FIELDS[f]!.hu}`, s[`f${i}`] ?? 0, total));
  console.log();
  row('TELJES azonossag (minden magmezo)', s['complete'] ?? 0, total);

  // ── 2. Mi lenne automatikusan lezarhato ────────────────────────────────
  const groups = await query<{ groups: number; shops_avg: number; pairs: number }>(
    `WITH g AS (
       SELECT ${GROUP_LIST},
              count(DISTINCT sl.shop_id)::int AS shops
         FROM source_listings sl
         JOIN product_categories pc ON pc.id = sl.category_id
        WHERE sl.listing_status = 'active' AND pc.key = 'wine'
          AND ${COMPLETE}
        GROUP BY ${GROUP_NUMS}
     )
     SELECT count(*) FILTER (WHERE shops >= 2)::int AS groups,
            coalesce(avg(shops) FILTER (WHERE shops >= 2), 0)::numeric(4,2) AS shops_avg,
            coalesce(sum(shops - 1) FILTER (WHERE shops >= 2), 0)::int AS pairs
       FROM g`,
  );
  const g = groups[0];

  // Az ar-or PARONKENT nez, nem csoportszinten: minden jelolt a kanonikus
  // oldal viszonyitasi arahoz mérodik, az pedig a mar igazolt boltok
  // legolcsobbja. Csoportszinten szamolva egyetlen kiugro ar az egesz
  // csoportot visszatartottnak mutatna - ez felrevezeto lenne.
  const joinOn = GROUP_COLS
    .map((c) => {
      const col = c.replace('sl.', '');
      return `grp.${col} IS NOT DISTINCT FROM b.${col}`;
    })
    .join(' AND ');
  const baseCols = GROUP_COLS.map((c) => c.replace('sl.', '')).join(', ');

  const held = await query<{ held: number }>(
    `WITH base AS (
       SELECT sl.shop_id, ${GROUP_LIST},
              o.selected_comparable_price_huf AS price
         FROM source_listings sl
         JOIN product_categories pc ON pc.id = sl.category_id
         LEFT JOIN offer_observations o ON o.id = sl.latest_offer_id
        WHERE sl.listing_status = 'active' AND pc.key = 'wine'
          AND ${COMPLETE}
     ), grp AS (
       SELECT ${baseCols},
              min(price) AS cheapest,
              count(DISTINCT shop_id)::int AS shops
         FROM base
        GROUP BY ${GROUP_NUMS}
     )
     SELECT count(*)::int AS held
       FROM base b
       JOIN grp ON ${joinOn}
      WHERE grp.shops >= 2 AND grp.cheapest > 0 AND b.price IS NOT NULL
        AND b.price <> grp.cheapest
        AND (b.price::numeric / grp.cheapest::numeric) > $1`,
    [priceRatioMax],
  );

  console.log('\n══ AMIT A GEP LEZARHATNA ════════════════════════════════════════════════\n');
  const pairs = g?.pairs ?? 0;
  const heldPairs = held[0]?.held ?? 0;
  row('tobb boltban is meglevo, teljes azonossagu termek', g?.groups ?? 0);
  row('lehetseges parositas osszesen', pairs);
  row('  ebbol az ar-or emberre bizna', heldPairs, pairs);
  row('  automatikusan igazolhato', Math.max(0, pairs - heldPairs), pairs);
  console.log(`  ${'atlagosan hany boltban'.padEnd(52)} ${String(g?.shops_avg ?? 0).padStart(7)}`);
  console.log(`\n  Az ar-or kuszobe: ${priceRatioMax}x`);

  // ── 2b. Melyik mezo mibe kerul ─────────────────────────────────────────
  //
  // A leghasznosabb diagnosztika nem az, hogy melyik mezo hianyzik a
  // legtobbszor, hanem hogy melyik hianyzik EGYEDULIKENT - vagyis hany
  // listing van meg egyetlen mezore a teljessegtol. Azokat egyetlen
  // kinyeresjavitas vagy egyetlen szabalydontes hozna at.
  console.log('\n══ MELYIK MEZO MIBE KERUL ═══════════════════════════════════════════════\n');
  console.log('  Hany listing van meg EGYETLEN mezore a teljessegtol:\n');
  for (const f of core) {
    const others = core.filter((x) => x !== f).map((x) => `(${FIELDS[x]!.proven})`).join(' AND ');
    const r = await query<{ n: number }>(
      `SELECT count(*)::int AS n
         FROM source_listings sl
         JOIN product_categories pc ON pc.id = sl.category_id
        WHERE sl.listing_status = 'active' AND pc.key = 'wine'
          AND NOT (${FIELDS[f]!.proven})
          ${others ? `AND ${others}` : ''}`,
    );
    row(`csak a(z) ${FIELDS[f]!.hu} hianyzik`, r[0]?.n ?? 0, total);
  }

  console.log('\n  Ha egy mezo sokba kerul, ket ut van: javitani a kinyerest, vagy');
  console.log('  kivenni az azonossagmagbol (migracio). A masodik csak akkor');
  console.log('  biztonsagos, ha a mezo `contradiction_only` marad - vagyis ismert');
  console.log('  elteres eseten tovabbra is kizar.');

  // ── 3. Mi marad emberre ────────────────────────────────────────────────
  const queue = await query<{ open_cases: number; variants: number }>(
    `SELECT count(*)::int AS open_cases,
            count(DISTINCT canonical_variant_id)::int AS variants
       FROM review_cases WHERE status IN ('open','in_progress')`,
  );
  const backlog = await query<{ count: number }>(
    `SELECT count(*)::int AS count
       FROM source_listings sl JOIN shops s ON s.id = sl.shop_id
      WHERE sl.listing_status = 'active' AND sl.cluster_status = 'unclustered'
        AND s.active AND NOT s.policy_disabled`,
  );

  console.log('\n══ AMI EMBERRE MARAD ════════════════════════════════════════════════════\n');
  row('nyitott ellenorzesi eset MA', queue[0]?.open_cases ?? 0);
  row('  ezek hany kepernyore surusodnek', queue[0]?.variants ?? 0);
  row('meg nem klaszterezett listing (hatralek)', backlog[0]?.count ?? 0);

  const flag = await query<{ enabled: boolean }>(
    `SELECT enabled FROM feature_flags WHERE key = 'auto_match_identity_complete'`,
  );
  console.log(`\n  Az automatikus jovahagyas jelenleg: ${flag[0]?.enabled ? 'BEKAPCSOLVA' : 'kikapcsolva'}`);

  if (!flag[0]?.enabled) {
    console.log('\n  Bekapcsolashoz:');
    console.log("    UPDATE feature_flags SET enabled = true WHERE key = 'auto_match_identity_complete';");
  }

  if ((s['complete'] ?? 0) < total * 0.3 && total > 0) {
    console.log('\n  FIGYELEM: a listingek kevesebb mint harmadan teljes az azonossag.');
    console.log('  Ilyenkor NEM a kuszobot kell lazitani - az hamis parokat termelne -,');
    console.log('  hanem a kinyerest javitani. Nezd meg fent, melyik mezo kerul a legtobbe.');
  }

  console.log();
  await closeDb();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
