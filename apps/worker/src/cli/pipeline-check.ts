/**
 * Miert nem fut az ujraertekeles?
 *
 * A `ops:recheck` megmondja, HANY sor esedekes - de nem mondja meg, hogy
 * elindult-e rajtuk barmi. A ket dolog kulon: a scheduler sorbaallitja a
 * jobot, a worker feldolgozza. Ha barmelyik lepes elakad, kivulrol ugyanaz
 * latszik: a szam nem mozdul.
 *
 * Ez a parancs a `job_runs` naplobol olvassa vissza, mi tortent valojaban -
 * mikor futott, meddig tartott, mit adott vissza, es ha elszallt, miert.
 *
 * A masodik resze a legfontosabb: kiszamolja a scheduler SZAMLALO
 * lekerdezeset es a processzor MUNKA lekerdezeset kulon-kulon. Ha a ketto
 * eltér, akkor a rendszer minden korben bekuld egy jobot olyan sorokra,
 * amiket a processzor nem is lat - a job lefut, nulla eredmennyel, a szam
 * pedig valtozatlan marad. Kivulrol ez pontosan ugy fest, mintha semmi nem
 * futna.
 *
 *   npm run ops:pipeline
 */
import { closeDb, initDb, query } from '@radovin/db';
import { configureLogger } from '@radovin/observability';

/** A parositasi lanc lepesei, sorrendben. */
const WATCHED: Array<[queue: string, job: string, mit: string]> = [
  ['product-ingest', 'propose-producers', 'boraszat-banyaszat'],
  ['product-ingest', 'reextract-listings', 'jovahagyas hatalyba lepese'],
  ['candidate-generation', 'cluster-sweep', 'klaszterezesi hatralek sopres'],
  ['candidate-generation', 'cluster-listing', 'egy listing beklaszterezese'],
  ['product-ingest', 'promote-listing-to-variant', 'uj kanonikus valtozat'],
  ['unmatched-research', 'research', 'ujraertekeles bolt-kozi keresessel'],
  ['aggregate-dashboard', 'rebuild', 'ar-osszehasonlitas ujraepitese'],
];

function ido(d: string | null): string {
  if (!d) return 'soha';
  const perc = Math.round((Date.now() - new Date(d).getTime()) / 60000);
  if (perc < 1) return 'most';
  if (perc < 60) return `${perc} perce`;
  const ora = Math.round(perc / 60);
  if (ora < 48) return `${ora} oraja`;
  return `${Math.round(ora / 24)} napja`;
}

async function main(): Promise<void> {
  configureLogger({ level: 'warn', pretty: true, service: 'pipeline-check' });
  const url = process.env['DATABASE_URL'];
  if (!url) throw new Error('A DATABASE_URL kornyezeti valtozo kotelezo.');
  initDb({ connectionString: url, max: 4, applicationName: 'radovin-pipeline-check' });

  console.log('\n══ A PAROSITASI LANC - MI FUTOTT LE VALOJABAN? ══════════════════════════\n');

  for (const [queue, job, mit] of WATCHED) {
    const last = await query<{
      status: string; queued_at: string; finished_at: string | null;
      duration_ms: number | null; error_message: string | null; result: unknown;
    }>(
      `SELECT status, queued_at::text, finished_at::text, duration_ms, error_message, result
         FROM job_runs WHERE queue = $1 AND job_name = $2
        ORDER BY queued_at DESC LIMIT 1`,
      [queue, job],
    );
    const stat = await query<{ status: string; count: number }>(
      `SELECT status, count(*)::int AS count FROM job_runs
        WHERE queue = $1 AND job_name = $2 AND queued_at > now() - interval '24 hours'
        GROUP BY status ORDER BY count(*) DESC`,
      [queue, job],
    );

    const l = last[0];
    console.log(`  ${mit}`);
    console.log(`    ${queue}/${job}`);
    if (!l) {
      console.log('    MEG SOHA NEM FUTOTT.');
    } else {
      const napi = stat.map((s) => `${s.status}:${s.count}`).join(' ') || 'nincs futas 24 oran belul';
      console.log(`    utoljara: ${ido(l.finished_at ?? l.queued_at)} · ${l.status}`
        + (l.duration_ms ? ` · ${Math.round(l.duration_ms / 1000)} mp` : ''));
      console.log(`    24 ora:   ${napi}`);
      if (l.error_message) {
        console.log(`    HIBA:     ${l.error_message.slice(0, 160)}`);
      }
      if (l.result) {
        console.log(`    eredmeny: ${JSON.stringify(l.result).slice(0, 200)}`);
      }
    }
    console.log();
  }

  // ── A ket lekerdezes osszevetese ────────────────────────────────────────
  //
  // A scheduler ezt SZAMOLJA, a processzor ezt DOLGOZZA FEL. Ha eltérnek, a
  // kulonbseg pontosan az a halmaz, amire hiaba indul job.
  console.log('══ ESEDEKES UJRAERTEKELESEK - SCHEDULER vs PROCESSZOR ═══════════════════\n');

  const nyers = await query<{ count: number }>(
    `SELECT count(*)::int AS count FROM variant_shop_status
      WHERE next_search_at IS NOT NULL AND next_search_at <= now()
        AND status NOT IN ('auto_verified','human_verified','suspended')`,
  );
  const valodi = await query<{ count: number }>(
    `SELECT count(*)::int AS count
       FROM variant_shop_status vss
       JOIN shops s ON s.id = vss.shop_id
       JOIN canonical_variants cv ON cv.id = vss.canonical_variant_id
      WHERE vss.next_search_at IS NOT NULL AND vss.next_search_at <= now()
        AND s.active AND NOT s.policy_disabled
        AND cv.status IN ('active','proposed')
        AND vss.status NOT IN ('auto_verified','human_verified','suspended')`,
  );

  const n = nyers[0]?.count ?? 0;
  const v = valodi[0]?.count ?? 0;
  console.log(`  esedekes sor (nyers szamlalas):            ${String(n).padStart(7)}`);
  console.log(`  ebbol a processzor tenylegesen latja:      ${String(v).padStart(7)}`);

  if (n > 0 && v === 0) {
    console.log('\n  ITT A HIBA. Van esedekes sor, de a processzor egyet sem lat.');
    // Melyik feltetel viszi nullara? Lepesenkent.
    const okok = await query<{ ok: string; count: number }>(
      `SELECT CASE
                WHEN NOT (s.active AND NOT s.policy_disabled) THEN 'a webshop inaktiv vagy tiltott'
                WHEN cv.status NOT IN ('active','proposed')   THEN 'a kanonikus valtozat allapota ' || cv.status
                ELSE 'egyeb'
              END AS ok,
              count(*)::int AS count
         FROM variant_shop_status vss
         JOIN shops s ON s.id = vss.shop_id
         JOIN canonical_variants cv ON cv.id = vss.canonical_variant_id
        WHERE vss.next_search_at IS NOT NULL AND vss.next_search_at <= now()
          AND vss.status NOT IN ('auto_verified','human_verified','suspended')
        GROUP BY 1 ORDER BY 2 DESC`,
    );
    for (const o of okok) console.log(`    ${String(o.count).padStart(6)} sor: ${o.ok}`);
  } else if (n === 0 && v === 0) {
    console.log('\n  Nincs esedekes ujraertekeles. Ha ez meglepo, futtasd:');
    console.log('    npm run ops:recheck -- --write');
  } else {
    console.log('\n  A ket szam egyezik - a scheduler es a processzor ugyanazt latja.');
  }

  // ── Van-e egyaltalan mit ujraertekelni? ─────────────────────────────────
  //
  // A `variant_shop_status` sorok NEM maguktol keletkeznek: egy igazolt
  // parositas nyitja meg oket a TOBBI boltra. Ha a tabla szinte ures, akkor
  // nem az ujraertekeles akadt el - egyszeruen nincs mibol kiindulni.
  console.log('\n══ VAN-E MIBOL KIINDULNI? ═══════════════════════════════════════════════\n');

  const alap = await query<{
    valtozat: number; vss: number; parok: number; boltok: number; listing: number;
    unclustered: number;
  }>(
    `SELECT (SELECT count(*)::int FROM canonical_variants WHERE status <> 'merged') AS valtozat,
            (SELECT count(*)::int FROM variant_shop_status) AS vss,
            (SELECT count(*)::int FROM match_relations
              WHERE status = 'verified' AND valid_to IS NULL) AS parok,
            (SELECT count(*)::int FROM shops WHERE active AND NOT policy_disabled) AS boltok,
            (SELECT count(*)::int FROM source_listings WHERE listing_status = 'active') AS listing,
            (SELECT count(*)::int FROM source_listings sl JOIN shops s ON s.id = sl.shop_id
              WHERE sl.listing_status = 'active' AND sl.cluster_status = 'unclustered'
                AND s.active AND NOT s.policy_disabled) AS unclustered`,
  );
  const a = alap[0];
  console.log(`  aktiv webshop                              ${String(a?.boltok ?? 0).padStart(7)}`);
  console.log(`  aktiv listing                              ${String(a?.listing ?? 0).padStart(7)}`);
  console.log(`    ebbol meg beklaszterezetlen              ${String(a?.unclustered ?? 0).padStart(7)}`);
  console.log(`  kanonikus valtozat                         ${String(a?.valtozat ?? 0).padStart(7)}`);
  console.log(`  igazolt parositas                          ${String(a?.parok ?? 0).padStart(7)}`);
  console.log(`  valtozat-bolt sor (ujraertekelheto)        ${String(a?.vss ?? 0).padStart(7)}`);

  if ((a?.unclustered ?? 0) > 0) {
    console.log('\n  A hatralek magatol fogy: a scheduler kotegenkent (300) sopri.');
    console.log('  Amig ez tart, uj valtozatok es uj bolt-kozi parok keletkeznek.');
  }
  if ((a?.vss ?? 0) < 100 && (a?.listing ?? 0) > 1000) {
    console.log('\n  A valtozat-bolt sorok szama feltunoen alacsony a katalogushoz kepest.');
    console.log('  Ezek a sorok NEM maguktol keletkeznek: egy igazolt parositas nyitja');
    console.log('  meg oket a tobbi boltra. Amig kevés az igazolt par, kevés az');
    console.log('  ujraertekelheto sor is - ilyenkor nem az ujraertekeles akadt el.');
  }

  console.log();
  await closeDb();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
