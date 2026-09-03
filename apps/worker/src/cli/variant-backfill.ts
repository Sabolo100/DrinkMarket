/**
 * A KANONIKUS oldal bor-azonossaganak potlasa a hozza kotott listingekbol.
 *
 * Az ujrakinyeres a `source_listings` oldalat toltotte fel (fajta, szin,
 * bortipus, dulo). A `canonical_variants` viszont ennel korabban keletkezett,
 * amikor ezek a mezok meg nem leteztek - ott tehat NULL maradt minden.
 *
 * Az osszehasonlitas KET oldalt nez. Ha a kanonikus oldalon a fajta
 * ismeretlen, akkor az azonossag sosem lehet teljes, barmennyire jol van
 * kitoltve a bolti oldal - es az automatikus jovahagyas nem tud tuzelni.
 * Pontosan ez tortent: a kapcsolo bekapcsolasa utan sem valtozott semmi.
 *
 * A potlas forrasa a valtozathoz MAR IGAZOLTAN hozzatartozo listing (vagy
 * amibol a valtozat keszult). Nem talalunk ki semmit: azt masoljuk at, amit
 * a rendszer mar bizonyitottnak tekint.
 *
 *   npm run ops:backfill            -- csak megszamolja
 *   npm run ops:backfill -- --write -- eles futas
 */
import { closeDb, initDb, query, transaction } from '@radovin/db';
import { configureLogger } from '@radovin/observability';

interface Row {
  variant_id: string;
  family_id: string;
  listing_id: string;
  grape_signature: string | null;
  wine_style_id: string | null;
  vineyard_id: string | null;
  wine_region_id: string | null;
  colour: string | null;
  grape_names: string[] | null;
  grape_ids: string[] | null;
}

/**
 * Melyik listingbol potoljunk?
 *
 * Sorrendben: a valtozathoz IGAZOLTAN kotott listingek kozul a legjobb
 * kinyeresi minosegu, ennek hianyaban az, amibol a valtozat keszult
 * (`origin_listing_id`). Csak olyan sor johet szoba, amin van fajtalenyomat -
 * enelkul nincs mit atmasolni.
 */
const SOURCE_SQL = `
  SELECT DISTINCT ON (cv.id)
         cv.id::text          AS variant_id,
         cv.product_family_id::text AS family_id,
         sl.id::text          AS listing_id,
         sl.grape_signature,
         sl.wine_style_id::text,
         sl.vineyard_id::text,
         sl.wine_region_id::text,
         sl.colour,
         g.names AS grape_names,
         g.ids   AS grape_ids
    FROM canonical_variants cv
    JOIN product_families pf ON pf.id = cv.product_family_id
    JOIN product_categories pc ON pc.id = pf.category_id
    JOIN source_listings sl
      ON sl.id = coalesce(
           (SELECT mr.source_listing_id FROM match_relations mr
             WHERE mr.canonical_variant_id = cv.id
               AND mr.status = 'verified' AND mr.valid_to IS NULL
             ORDER BY mr.last_verified_at DESC NULLS LAST
             LIMIT 1),
           cv.origin_listing_id)
    LEFT JOIN LATERAL (
      SELECT array_agg(gv.canonical_name ORDER BY gv.canonical_name) AS names,
             array_agg(slg.grape_variety_id::text ORDER BY gv.canonical_name) AS ids
        FROM source_listing_grapes slg
        JOIN grape_varieties gv ON gv.id = slg.grape_variety_id
       WHERE slg.source_listing_id = sl.id
    ) g ON true
   WHERE pc.key IN ('wine','sparkling_wine','champagne','tokaji_aszu')
     AND cv.status <> 'merged'
     AND sl.grape_signature IS NOT NULL
     -- Csak ahol tenylegesen hianyzik valami. Ami mar ki van toltve, ahhoz
     -- nem nyulunk: egy kezi javitast nem irhat felul egy potlas.
     AND (cv.grape_signature IS NULL OR pf.colour IS NULL)
   ORDER BY cv.id, sl.extraction_quality DESC NULLS LAST
`;

async function main(): Promise<void> {
  configureLogger({ level: 'warn', pretty: true, service: 'backfill' });
  const url = process.env['DATABASE_URL'];
  if (!url) throw new Error('A DATABASE_URL kornyezeti valtozo kotelezo.');
  initDb({ connectionString: url, max: 4, applicationName: 'radovin-backfill' });

  const write = process.argv.includes('--write');

  const before = await query<{
    osszes: number; van_fajta: number; van_szin: number; van_evjarat: number;
  }>(
    `SELECT count(*)::int AS osszes,
            count(*) FILTER (WHERE cv.grape_signature IS NOT NULL)::int AS van_fajta,
            count(*) FILTER (WHERE pf.colour IS NOT NULL)::int AS van_szin,
            count(*) FILTER (WHERE cv.vintage_value IS NOT NULL)::int AS van_evjarat
       FROM canonical_variants cv
       JOIN product_families pf ON pf.id = cv.product_family_id
       JOIN product_categories pc ON pc.id = pf.category_id
      WHERE pc.key IN ('wine','sparkling_wine','champagne','tokaji_aszu')
        AND cv.status <> 'merged'`,
  );
  const b = before[0];

  console.log('\n══ A KANONIKUS OLDAL AZONOSSAGA ═════════════════════════════════════════\n');
  const t = b?.osszes ?? 0;
  const p = (n: number) => (t ? `${((n / t) * 100).toFixed(1)}%`.padStart(7) : '');
  console.log(`  bor-kategoriaju kanonikus valtozat         ${String(t).padStart(7)}`);
  console.log(`    van fajtalenyomata                       ${String(b?.van_fajta ?? 0).padStart(7)} ${p(b?.van_fajta ?? 0)}`);
  console.log(`    van szine                                ${String(b?.van_szin ?? 0).padStart(7)} ${p(b?.van_szin ?? 0)}`);
  console.log(`    van evjarata                             ${String(b?.van_evjarat ?? 0).padStart(7)} ${p(b?.van_evjarat ?? 0)}`);

  const rows = await query<Row>(SOURCE_SQL);
  console.log(`\n  potolhato a hozzajuk kotott listingbol:    ${String(rows.length).padStart(7)}`);

  if (!rows.length) {
    console.log('\n  Nincs mit potolni.\n');
    await closeDb();
    return;
  }

  if (!write) {
    console.log('\n  Peldak:\n');
    for (const r of rows.slice(0, 5)) {
      console.log(`    ${(r.grape_names ?? []).join(', ') || '-'} · ${r.colour ?? '-'}`);
    }
    console.log('\n  Semmi nem valtozott. Az eles futashoz: -- --write');
    console.log('  Utana erdemes `ops:recheck -- --write`, hogy a mar nyitott');
    console.log('  esetek is ujraertekelodjenek.\n');
    await closeDb();
    return;
  }

  let variants = 0;
  let families = 0;
  const CHUNK = 100;

  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    await transaction(async (client) => {
      for (const r of chunk) {
        // A valtozat bor-mezoi. `coalesce`: ami mar ki van toltve, marad.
        const v = await client.query(
          `UPDATE canonical_variants SET
             grape_signature = coalesce(grape_signature, $2),
             wine_style_id   = coalesce(wine_style_id, $3::uuid),
             vineyard_id     = coalesce(vineyard_id, $4::uuid),
             wine_region_id  = coalesce(wine_region_id, $5::uuid)
           WHERE id = $1`,
          [r.variant_id, r.grape_signature, r.wine_style_id, r.vineyard_id, r.wine_region_id],
        );
        variants += v.rowCount ?? 0;

        const f = await client.query(
          `UPDATE product_families SET
             colour          = coalesce(colour, $2),
             grape_varieties = CASE WHEN coalesce(array_length(grape_varieties,1),0) = 0
                                    THEN $3::text[] ELSE grape_varieties END,
             wine_style_id   = coalesce(wine_style_id, $4::uuid)
           WHERE id = $1`,
          [r.family_id, r.colour, r.grape_names ?? [], r.wine_style_id],
        );
        families += f.rowCount ?? 0;

        // A fajta-kapcsolotablak. Az azonossag az azonositokon dol el, nem a
        // szoveges tombon - ezert ezeket is fel kell tolteni.
        for (const [pos, id] of (r.grape_ids ?? []).entries()) {
          await client.query(
            `INSERT INTO canonical_variant_grapes (canonical_variant_id, grape_variety_id, position)
             VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
            [r.variant_id, id, pos + 1],
          );
          await client.query(
            `INSERT INTO product_family_grapes (product_family_id, grape_variety_id, position)
             VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
            [r.family_id, id, pos + 1],
          );
        }
      }
    });
  }

  console.log(`\n  ${variants} valtozat es ${families} termekcsalad kiegeszitve.`);

  console.log('\n  Kovetkezo lepes, hogy a mar nyitott esetek is ujraertekelodjenek:');
  console.log('    npm run ops:recheck -- --write\n');

  await closeDb();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
