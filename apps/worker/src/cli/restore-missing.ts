/**
 * Bizonyitek nelkul "eltuntnek" jelolt termekek visszaallitasa.
 *
 * Egy arfrissites, ami EGYETLEN HTTP kerest sem kuldott ki, 1114 terméket
 * jelolt eltuntnek - majd egy masik 497-et. A publikalas `active` listinget
 * kovetel, ezert ezzel a katalogus ketharmada kiesett a piaci oldalrol.
 *
 * A jelolesnek nem volt alapja: a bolt meg sem szolalt. A javitas
 * (`isDisappearanceEvidence`) ezt megakadalyozza a jovoben; ez a parancs a
 * MAR MEGTORTENT karokat vonja vissza.
 *
 * Nem talal ki semmit: a `crawl_runs` naploja alapjan azonositja azokat a
 * futasokat, amik nulla keresset jeloltek meg sorokat, es kizarolag az
 * ezekben az idoablakokban `missing`-re allitott sorokat allitja vissza.
 *
 *   npm run ops:restore-missing            -- csak megmutatja
 *   npm run ops:restore-missing -- --write -- eles futas
 */
import { closeDb, execute, initDb, query } from '@radovin/db';
import { configureLogger } from '@radovin/observability';

/**
 * A gyanus futasok: jeloltek meg sorokat, de nem kuldtek kerest.
 *
 * A `+ interval '2 minutes'` a futas veget koveto rovid savot is befogja:
 * a `missing_since` a jeloles pillanataban keletkezik, ami a futas ALATT
 * van, de az orak kozti eltolodas miatt erdemes egy kis rest hagyni.
 */
const SUSPECT_RUNS = `
  SELECT r.id::text, s.key AS shop_key, s.id::text AS shop_id,
         r.started_at, coalesce(r.finished_at, r.started_at) AS finished_at,
         r.listings_missing
    FROM crawl_runs r
    JOIN shops s ON s.id = r.shop_id
   WHERE r.run_type = 'price_refresh'
     AND coalesce(r.requests_attempted, 0) = 0
     AND coalesce(r.listings_missing, 0) > 0
   ORDER BY r.started_at DESC
`;

async function main(): Promise<void> {
  configureLogger({ level: 'warn', pretty: true, service: 'restore-missing' });
  const url = process.env['DATABASE_URL'];
  if (!url) throw new Error('A DATABASE_URL kornyezeti valtozo kotelezo.');
  initDb({ connectionString: url, max: 4, applicationName: 'radovin-restore' });

  const write = process.argv.includes('--write');

  const runs = await query<{
    id: string; shop_key: string; shop_id: string;
    started_at: Date; finished_at: Date; listings_missing: number;
  }>(SUSPECT_RUNS);

  console.log('\n══ BIZONYITEK NELKUL ELTUNTNEK JELOLT TERMEKEK ══════════════════════════\n');

  if (!runs.length) {
    console.log('  Nincs olyan arfrissites, ami keres nelkul jelolt volna meg sorokat.\n');
    await closeDb();
    return;
  }

  console.log('  Gyanus futasok (nulla keres, megis jeloltek):\n');
  for (const r of runs) {
    console.log(`    ${r.started_at.toISOString()}  ${r.shop_key.padEnd(14)}`
      + `  ${String(r.listings_missing).padStart(5)} jeloles`);
  }

  // Melyik sorok erintettek? Kizarolag azok, amik EBBEN az idoablakban
  // lettek `missing`, es azota sem alltak vissza.
  let total = 0;
  let restored = 0;

  for (const r of runs) {
    const rows = await query<{ count: number }>(
      `SELECT count(*)::int AS count
         FROM source_listings
        WHERE shop_id = $1 AND listing_status = 'missing'
          AND missing_since BETWEEN $2 AND $3::timestamptz + interval '2 minutes'`,
      [r.shop_id, r.started_at, r.finished_at],
    );
    const n = rows[0]?.count ?? 0;
    total += n;

    if (write && n > 0) {
      // A `missing_since` es a `consecutive_failures` is visszaall: a
      // jeloles nem tortent meg, tehat a nyoma sem maradhat.
      const res = await execute(
        `UPDATE source_listings
            SET listing_status = 'active',
                missing_since = NULL,
                consecutive_failures = greatest(consecutive_failures - 1, 0)
          WHERE shop_id = $1 AND listing_status = 'missing'
            AND missing_since BETWEEN $2 AND $3::timestamptz + interval '2 minutes'`,
        [r.shop_id, r.started_at, r.finished_at],
      );
      restored += res;

      // A parositasi oldal allapota is visszaall: a `listing_missing` jelzes
      // ugyanabbol a teves dontesbol szarmazott.
      await execute(
        `UPDATE variant_shop_status vss
            SET status = 'needs_review', next_search_at = now()
          FROM match_relations mr
          WHERE mr.shop_id = $1 AND mr.valid_to IS NULL
            AND vss.canonical_variant_id = mr.canonical_variant_id
            AND vss.shop_id = mr.shop_id
            AND vss.status = 'listing_missing'`,
        [r.shop_id],
      );
    }
  }

  console.log(`\n  visszaallithato sor:                        ${String(total).padStart(7)}`);

  if (!write) {
    console.log('\n  Semmi nem valtozott. Az eles futashoz: -- --write');
    console.log('  Utana erdemes a Folyamatkezeles lapon:');
    console.log('    "Ar-osszehasonlitas ujraepitese"\n');
    await closeDb();
    return;
  }

  console.log(`  ${restored} sor visszaallitva aktivra.\n`);
  console.log('  A piaci oldal a kovetkezo publikalastol lesz teljes.');
  console.log('  Folyamatkezeles -> "Ar-osszehasonlitas ujraepitese".\n');

  await closeDb();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
