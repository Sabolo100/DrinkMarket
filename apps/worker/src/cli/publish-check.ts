/**
 * Miert ures az ar-osszehasonlitas?
 *
 * A felulet uzenete ("akkor telik meg, ha legalabb egy webshop katalogusa
 * betoltodott") felrevezeto: NINCS ilyen szabaly. Egyetlen termek is
 * megjelenik, ha van ra igazolt parositas es osszehasonlithato ar.
 *
 * A publikalas nyolc feltetelt tamaszt egyszerre. Ha barmelyik nem teljesul,
 * a vegeredmeny nulla - de a felulet nem mondja meg, MELYIK. Ez a parancs
 * lepesenkent vegigmegy a tolcseren, es megmutatja, hol esik le a szam.
 *
 *   npm run ops:publish-check
 */
import { closeDb, initDb, query } from '@radovin/db';
import { configureLogger } from '@radovin/observability';

/**
 * A tolcser lepesei. Minden lepes az elozo WHERE-jet orokli, es hozzatesz
 * egyet - igy pontosan lathato, melyik feltetel viszi nullara.
 */
const STEPS: Array<[string, string]> = [
  ['igazolt parositas (verified, ervenyes)',
   `mr.status = 'verified' AND mr.valid_to IS NULL`],
  ['+ a listing meg aktiv',
   `sl.listing_status = 'active'`],
  ['+ a webshop aktiv',
   `s.active`],
  ['+ a valtozat allapota active vagy proposed',
   `cv.status IN ('active','proposed')`],
  ['+ van legfrissebb ajanlat',
   `sl.latest_offer_id IS NOT NULL`],
  ['+ az ar osszehasonlithato',
   `o.comparable`],
  ['+ nincs karantenban',
   `NOT o.quarantined`],
  ['+ van pozitiv ara',
   `o.selected_comparable_price_huf > 0`],
];

const FROM = `
  FROM match_relations mr
  JOIN source_listings sl ON sl.id = mr.source_listing_id
  JOIN shops s ON s.id = mr.shop_id
  JOIN canonical_variants cv ON cv.id = mr.canonical_variant_id
  LEFT JOIN offer_observations o ON o.id = sl.latest_offer_id
`;

async function main(): Promise<void> {
  configureLogger({ level: 'warn', pretty: true, service: 'publish-check' });
  const url = process.env['DATABASE_URL'];
  if (!url) throw new Error('A DATABASE_URL kornyezeti valtozo kotelezo.');
  initDb({ connectionString: url, max: 4, applicationName: 'radovin-publish-check' });

  console.log('\n══ MIERT URES AZ AR-OSSZEHASONLITAS? ════════════════════════════════════\n');

  // A leggyakoribb es legkonnyebben atsiklott ok. A publikalas `s.active`-ot
  // kovetel, tehat egy inaktiv bolt ajanlata sosem kerul a piacra - barmennyi
  // igazolt parositas legyen is mogotte.
  const shops = await query<{ osszes: number; aktiv: number }>(
    `SELECT count(*)::int AS osszes,
            count(*) FILTER (WHERE active AND NOT policy_disabled)::int AS aktiv
       FROM shops`,
  );
  console.log(`  webshop: ${shops[0]?.osszes ?? 0}, ebbol aktiv: ${shops[0]?.aktiv ?? 0}`);
  if ((shops[0]?.aktiv ?? 0) === 0) {
    console.log('\n  EGYETLEN AKTIV WEBSHOP SINCS - a publikalas ezert ures.');
    console.log('  A boltokat a webalkalmazas Webshopok oldalan lehet aktivalni.');
  }

  console.log('\n  A publikalas tolcsere - hol esik le a szam:\n');

  const acc: string[] = [];
  let last = -1;
  let brokeAt: string | null = null;

  for (const [label, cond] of STEPS) {
    acc.push(`(${cond})`);
    const r = await query<{ parok: number; valtozatok: number }>(
      `SELECT count(*)::int AS parok,
              count(DISTINCT mr.canonical_variant_id)::int AS valtozatok
         ${FROM} WHERE ${acc.join(' AND ')}`,
    );
    const parok = r[0]?.parok ?? 0;
    const valtozatok = r[0]?.valtozatok ?? 0;
    const drop = last >= 0 && parok < last ? `  (-${last - parok})` : '';
    console.log(`  ${label.padEnd(46)} ${String(parok).padStart(6)} par · ${String(valtozatok).padStart(5)} valtozat${drop}`);
    if (last > 0 && parok === 0 && !brokeAt) brokeAt = label;
    last = parok;
  }

  // Hany valtozat van legalabb ket boltban? Ez az, ami VALODI
  // osszehasonlitast ad - de egy boltos sor is megjelenik a piacon.
  const multi = await query<{ tobb: number; egy: number }>(
    `WITH v AS (
       SELECT mr.canonical_variant_id, count(DISTINCT mr.shop_id)::int AS boltok
         ${FROM} WHERE ${STEPS.map(([, c]) => `(${c})`).join(' AND ')}
        GROUP BY 1
     )
     SELECT count(*) FILTER (WHERE boltok >= 2)::int AS tobb,
            count(*) FILTER (WHERE boltok = 1)::int AS egy
       FROM v`,
  );

  console.log(`\n  ebbol tobb boltban:                            ${String(multi[0]?.tobb ?? 0).padStart(6)}`);
  console.log(`  csak egy boltban:                              ${String(multi[0]?.egy ?? 0).padStart(6)}`);

  // A legutobbi publikacio.
  const pub = await query<{ publikalt_at: string; valtozat: number; ajanlat: number }>(
    `SELECT p.published_at::text AS publikalt_at,
            (SELECT count(*)::int FROM market_variant_summary WHERE publication_id = p.id) AS valtozat,
            (SELECT count(*)::int FROM market_offers WHERE publication_id = p.id) AS ajanlat
       FROM v_current_publication p`,
  );
  console.log('\n══ A LEGUTOBBI PUBLIKACIO ═══════════════════════════════════════════════\n');
  if (!pub.length) {
    console.log('  Meg nem futott publikalas.');
  } else {
    console.log(`  ideje:       ${pub[0]!.publikalt_at}`);
    console.log(`  valtozat:    ${pub[0]!.valtozat}`);
    console.log(`  ajanlat:     ${pub[0]!.ajanlat}`);
  }

  if (brokeAt) {
    console.log(`\n  ITT ESIK NULLARA: "${brokeAt}"\n`);
  } else if (last === 0) {
    console.log('\n  Egyetlen igazolt parositas sincs. Eloszor a parositasnak kell');
    console.log('  letrejonnie - lasd `ops:triage`.\n');
  } else if ((pub[0]?.ajanlat ?? 0) === 0) {
    console.log('\n  Van publikalhato adat, de a legutobbi publikacio ures.');
    console.log('  A scheduler oránként ujraepiti; kezi inditas a webalkalmazasbol.\n');
  } else {
    console.log();
  }

  await closeDb();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
