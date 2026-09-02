/**
 * Boraszat-jeloltek banyaszasa a korpuszbol (a terv 2. fazisa, szaraz futas).
 *
 * Csak OLVAS. Semmit nem ir az adatbazisba - a `producers` tablaba emberi
 * jovahagyas nelkul nem kerulhet sor.
 *
 * Hasznalat a konteneren belul:
 *   node apps/worker/dist/cli/producer-mine.js [min_bolt] [limit]
 *
 * Pelda:
 *   node apps/worker/dist/cli/producer-mine.js        # alap: >=2 bolt, 300 jelolt
 *   node apps/worker/dist/cli/producer-mine.js 1 500  # egyboltosakat is
 */
import { closeDb, initDb, query } from '@radovin/db';
import { configureLogger } from '@radovin/observability';
import { parseWineName, mineProducerCandidates, type MineInput } from '@radovin/domain';
import { loadWineVocabulary } from '../lib/wine-vocab.js';

/**
 * Csak a BOR-boltok. Az elso meres tanulsaga: a tomeny boltok (whiskynet,
 * goodspirit, idrinks) 3591 listingje tiszta zajt adott a rangsorba - a
 * `whisky`, `cask`, `single` tokenek vittek a lista elejet.
 */
const WINE_SHOPS = ['radovin', 'bortarsasag', 'veritas', 'winehub', 'winelovers', 'borhalo'];

interface Row {
  shop_key: string;
  raw_name: string;
}

async function main(): Promise<void> {
  configureLogger({ level: 'warn', pretty: true, service: 'producer-mine' });

  const url = process.env['DATABASE_URL'];
  if (!url) throw new Error('A DATABASE_URL kornyezeti valtozo kotelezo.');
  initDb({
    connectionString: url,
    ssl: process.env['DATABASE_SSL'] === 'true',
    max: 4,
    applicationName: 'radovin-producer-mine',
  });

  const minShops = Number.parseInt(process.argv[2] ?? '', 10) || 2;
  const limit = Number.parseInt(process.argv[3] ?? '', 10) || 300;

  const { vocab, counts } = await loadWineVocabulary();
  const rows = await query<Row>(
    `SELECT s.key AS shop_key, sl.raw_name
       FROM source_listings sl
       JOIN shops s ON s.id = sl.shop_id
      WHERE sl.listing_status = 'active'
        AND s.key = ANY($1::text[])
        AND length(btrim(sl.raw_name)) > 2`,
    [WINE_SHOPS],
  );

  process.stdout.write('\n=== BEMENET ===\n');
  process.stdout.write(`  bor-boltok: ${WINE_SHOPS.join(', ')}\n`);
  process.stdout.write(`  listing: ${rows.length}\n`);
  process.stdout.write(`  szotar: fajta ${counts.grape}, bortipus ${counts.style}, `);
  process.stdout.write(`borvidek ${counts.region}, boraszat ${counts.producer}\n`);
  process.stdout.write(`  kuszob: legalabb ${minShops} bolt (jelolos nevnel nem kotelezo)\n`);

  // A slot-kitoltes utan megmarado tokenek - ebbol banyaszunk.
  const inputs: MineInput[] = [];
  let emptyResidue = 0;
  for (const r of rows) {
    const parsed = parseWineName(r.raw_name, vocab);
    const residue = (parsed.expression ?? '').split(' ').filter(Boolean);
    if (!residue.length) { emptyResidue++; continue; }
    inputs.push({ shopKey: r.shop_key, rawName: r.raw_name, residueTokens: residue });
  }
  process.stdout.write(`  ebbol maradek nelkuli: ${emptyResidue}\n`);

  const candidates = mineProducerCandidates(inputs, { minShops, limit });

  process.stdout.write(`\n=== BORASZAT-JELOLTEK (${candidates.length}) ===\n`);
  process.stdout.write('  J = termelonev-jelolot tartalmaz (Château, Pince, Weingut, ...)\n');
  process.stdout.write('  Sz = magyar szemelynev-mintara illik -> fuzzy egyezes tiltando\n\n');
  process.stdout.write(
    '  ' + 'pont'.padStart(6) + '  ' + 'db'.padStart(5) + '  ' + 'bolt'.padStart(4) +
    '  JSz  ' + 'jelolt'.padEnd(34) + 'pelda\n',
  );
  process.stdout.write('  ' + '-'.repeat(110) + '\n');

  for (const c of candidates) {
    const flags = `${c.hasMarker ? 'J' : ' '}${c.personName ? 'Sz' : '  '}`;
    const example = (c.examples[0] ?? '').slice(0, 44);
    process.stdout.write(
      `  ${String(c.score).padStart(6)}  ${String(c.count).padStart(5)}  ${String(c.shops).padStart(4)}` +
      `  ${flags}  ${c.name.slice(0, 33).padEnd(34)}${example}\n`,
    );
  }

  const withMarker = candidates.filter((c) => c.hasMarker).length;
  const persons = candidates.filter((c) => c.personName).length;
  process.stdout.write(`\n  Ebbol jelolos: ${withMarker}   szemelynev: ${persons}\n`);
  process.stdout.write('\n  A lista JAVASLAT. Semmi nem kerult az adatbazisba.\n\n');
}

main()
  .catch((err) => {
    process.stderr.write(`\nA banyaszat nem futott le:\n${err instanceof Error ? err.message : String(err)}\n\n`);
    process.exitCode = 1;
  })
  .finally(() => void closeDb());
