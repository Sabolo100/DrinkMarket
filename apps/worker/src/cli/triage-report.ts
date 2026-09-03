/**
 * Szarazpróba: mennyit zarna le a gep, es mennyi maradna emberre?
 *
 * A hármas szuro hozama NEM a szabalyon mulik, hanem a kinyeres
 * teljessegen. Ha keves listingen van meg mind a negy bor-slot, akkor az
 * automatika keveset zar le - es ilyenkor NEM a kuszobot kell lazitani
 * (az hamis parokat termelne), hanem a kinyeres hianyat javitani.
 *
 * Ezert fut ez a parancs a kapcsolo bekapcsolasa ELOTT. Semmit nem ir.
 *
 *   npm run match:triage
 */
import { closeDb, initDb, query } from '@radovin/db';
import { configureLogger } from '@radovin/observability';

/**
 * A bor azonossagmagja - ugyanaz, amit a 0018 migracio a kategoriara ir.
 * Itt SQL-ben ismeteljuk meg, mert a teljes motor lefuttatasa huszezer
 * listingen percekig tartana, es a kerdes megvalaszolasahoz nem kell.
 */
const WINE_CORE_COMPLETE = `
  sl.producer_id IS NOT NULL
  AND sl.grape_signature IS NOT NULL
  AND sl.colour IS NOT NULL
  AND sl.vintage_value IS NOT NULL
  AND sl.vintage_status = 'vintage'
  AND sl.volume_ml IS NOT NULL
  AND sl.pack_count IS NOT NULL
  AND sl.packaging_type IS NOT NULL
`;

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
      `SELECT coalesce(value->>'priceRatioMax','3.0') AS v FROM settings WHERE key='matching.thresholds'`,
    ))[0]?.v ?? 3.0,
  );

  // ── 1. A kinyeres teljessege ───────────────────────────────────────────
  const slots = await query<{
    total: number; producer: number; grape: number; colour: number;
    vintage: number; volume: number; complete: number;
  }>(
    `SELECT count(*)::int AS total,
            count(*) FILTER (WHERE sl.producer_id IS NOT NULL)::int AS producer,
            count(*) FILTER (WHERE sl.grape_signature IS NOT NULL)::int AS grape,
            count(*) FILTER (WHERE sl.colour IS NOT NULL)::int AS colour,
            count(*) FILTER (WHERE sl.vintage_value IS NOT NULL
                               AND sl.vintage_status = 'vintage')::int AS vintage,
            count(*) FILTER (WHERE sl.volume_ml IS NOT NULL)::int AS volume,
            count(*) FILTER (WHERE ${WINE_CORE_COMPLETE})::int AS complete
       FROM source_listings sl
       JOIN product_categories pc ON pc.id = sl.category_id
      WHERE sl.listing_status = 'active' AND pc.key = 'wine'`,
  );
  const s = slots[0];
  const total = s?.total ?? 0;

  console.log('\n══ A BOR-LISTINGEK AZONOSSAGA ═══════════════════════════════════════════\n');
  row('bor kategoriaju aktiv listing', total);
  console.log();
  row('van jovahagyott boraszata', s?.producer ?? 0, total);
  row('van fajtalenyomata', s?.grape ?? 0, total);
  row('van szine', s?.colour ?? 0, total);
  row('van bizonyitott evjarata', s?.vintage ?? 0, total);
  row('van kiszerelese', s?.volume ?? 0, total);
  console.log();
  row('TELJES azonossag (minden magmezo)', s?.complete ?? 0, total);

  // ── 2. Mi lenne automatikusan lezarhato ────────────────────────────────
  const groups = await query<{
    groups: number; listings: number; shops_avg: number; pairs: number;
  }>(
    `WITH g AS (
       SELECT sl.producer_id, sl.grape_signature, sl.colour, sl.vintage_value,
              sl.volume_ml, sl.pack_count, sl.packaging_type,
              count(*)::int AS n,
              count(DISTINCT sl.shop_id)::int AS shops,
              min(o.selected_comparable_price_huf) AS min_price,
              max(o.selected_comparable_price_huf) AS max_price
         FROM source_listings sl
         JOIN product_categories pc ON pc.id = sl.category_id
         LEFT JOIN offer_observations o ON o.id = sl.latest_offer_id
        WHERE sl.listing_status = 'active' AND pc.key = 'wine'
          AND ${WINE_CORE_COMPLETE}
        GROUP BY 1,2,3,4,5,6,7
     )
     SELECT count(*) FILTER (WHERE shops >= 2)::int AS groups,
            coalesce(sum(n) FILTER (WHERE shops >= 2), 0)::int AS listings,
            coalesce(avg(shops) FILTER (WHERE shops >= 2), 0)::numeric(4,2) AS shops_avg,
            coalesce(sum(shops - 1) FILTER (WHERE shops >= 2), 0)::int AS pairs
       FROM g`,
  );
  const g = groups[0];

  // Az ar-or PARONKENT nez, nem csoportszinten: minden jelolt a kanonikus
  // oldal viszonyitasi arahoz mérodik, az pedig a mar igazolt boltok
  // legolcsobbja. Csoportszinten szamolva egyetlen kiugro ar az egesz
  // csoportot visszatartottnak mutatna - ez felrevezeto lenne.
  const held = await query<{ held: number }>(
    `WITH base AS (
       SELECT sl.id, sl.shop_id,
              sl.producer_id, sl.grape_signature, sl.colour, sl.vintage_value,
              sl.volume_ml, sl.pack_count, sl.packaging_type,
              o.selected_comparable_price_huf AS price
         FROM source_listings sl
         JOIN product_categories pc ON pc.id = sl.category_id
         LEFT JOIN offer_observations o ON o.id = sl.latest_offer_id
        WHERE sl.listing_status = 'active' AND pc.key = 'wine'
          AND ${WINE_CORE_COMPLETE}
     ), grp AS (
       SELECT producer_id, grape_signature, colour, vintage_value,
              volume_ml, pack_count, packaging_type,
              min(price) AS cheapest,
              count(DISTINCT shop_id)::int AS shops
         FROM base
        GROUP BY 1,2,3,4,5,6,7
     )
     SELECT count(*)::int AS held
       FROM base b
       JOIN grp ON grp.producer_id = b.producer_id
                AND grp.grape_signature = b.grape_signature
                AND grp.colour = b.colour
                AND grp.vintage_value = b.vintage_value
                AND grp.volume_ml = b.volume_ml
                AND grp.pack_count = b.pack_count
                AND grp.packaging_type = b.packaging_type
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
    console.log('\n  Bekapcsolashoz a webalkalmazas Beallitasok lapjan, vagy:');
    console.log("    UPDATE feature_flags SET enabled = true WHERE key = 'auto_match_identity_complete';");
  }

  if ((s?.complete ?? 0) < total * 0.3 && total > 0) {
    console.log('\n  FIGYELEM: a listingek kevesebb mint harmadan teljes az azonossag.');
    console.log('  Ilyenkor NEM a kuszobot kell lazitani - az hamis parokat termelne -,');
    console.log('  hanem a kinyerest javitani. Nezd meg fent, melyik slot hianyzik a legtobbszor.');
  }

  console.log();
  await closeDb();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
