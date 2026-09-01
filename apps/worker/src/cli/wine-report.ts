/**
 * Bor-korpuszriport (a terv 0. fazisa).
 *
 * Csak OLVAS. Semmit nem ir az adatbazisba.
 *
 * Ket kerdesre valaszol, mielott barmit epitenenk a szotarra:
 *
 *   1. Fog-e egyaltalan a szotar a VALOS bolti neveken? Slotonkent megmutatja,
 *      hany szazalekban sikerult kitolteni, boltonkenti bontasban.
 *   2. Mi maradt ki? A maradek tokenek gyakorisagi listaja gyakorlatilag a
 *      BORASZAT-JELOLTEK listaja - a producers tabla ma ures, es ezt a listat
 *      fogja a 2. fazis feldolgozni.
 *
 * Hasznalat a konteneren belul:
 *   node apps/worker/dist/cli/wine-report.js [limit]
 */
import { closeDb, initDb, query } from '@radovin/db';
import { configureLogger } from '@radovin/observability';
import { parseWineName, type WineParseResult } from '@radovin/domain';
import { loadWineVocabulary } from '../lib/wine-vocab.js';

interface ListingRow {
  id: string;
  shop_key: string;
  raw_name: string;
  vintage_value: number | null;
  volume_ml: number | null;
}

const BAR_WIDTH = 28;

function pct(part: number, total: number): number {
  return total === 0 ? 0 : (part / total) * 100;
}

function bar(value: number): string {
  const filled = Math.round((value / 100) * BAR_WIDTH);
  return '#'.repeat(filled) + '.'.repeat(BAR_WIDTH - filled);
}

function line(label: string, part: number, total: number): string {
  const p = pct(part, total);
  return `  ${label.padEnd(22)} ${bar(p)} ${p.toFixed(1).padStart(5)}%  (${part}/${total})\n`;
}

async function main(): Promise<void> {
  configureLogger({ level: 'warn', pretty: true, service: 'wine-report' });

  const url = process.env['DATABASE_URL'];
  if (!url) throw new Error('A DATABASE_URL kornyezeti valtozo kotelezo.');
  initDb({
    connectionString: url,
    ssl: process.env['DATABASE_SSL'] === 'true',
    max: 4,
    applicationName: 'radovin-wine-report',
  });

  const limit = Number.parseInt(process.argv[2] ?? '', 10) || 100000;

  const { vocab, counts } = await loadWineVocabulary();
  process.stdout.write('\n=== SZOTAR ===\n');
  process.stdout.write(`  borászat ${counts.producer}   fajta ${counts.grape}   `);
  process.stdout.write(`bortipus ${counts.style}   borvidek ${counts.region}   dulo ${counts.vineyard}\n`);
  process.stdout.write(`  osszes felismerheto kifejezes (aliasokkal): ${vocab.size}\n`);

  if (counts.producer === 0) {
    process.stdout.write(
      '\n  FIGYELEM: a producers tabla URES. A borászat a bor kategoriaban\n' +
      '  kotelezo (required) mezo, ezert amig ures, EGYETLEN borparositas sem\n' +
      '  tud sikerulni. A lenti "maradek tokenek" lista pontosan azt mutatja,\n' +
      '  amibol a borászatszotar felepitheto.\n',
    );
  }

  const listings = await query<ListingRow>(
    `SELECT sl.id::text, s.key AS shop_key, sl.raw_name, sl.vintage_value, sl.volume_ml
       FROM source_listings sl
       JOIN shops s ON s.id = sl.shop_id
       LEFT JOIN product_categories c ON c.id = sl.category_id
      WHERE sl.listing_status = 'active'
        AND (c.kind = 'wine' OR c.kind IS NULL)
      ORDER BY s.key, sl.raw_name
      LIMIT $1`,
    [limit],
  );

  if (!listings.length) {
    process.stdout.write('\nNincs feldolgozhato listing.\n\n');
    return;
  }

  interface Tally {
    total: number;
    producer: number; grape: number; style: number;
    region: number; vineyard: number; vintage: number;
    allFour: number; ambiguous: number; emptyResidue: number;
  }
  const blank = (): Tally => ({
    total: 0, producer: 0, grape: 0, style: 0, region: 0, vineyard: 0,
    vintage: 0, allFour: 0, ambiguous: 0, emptyResidue: 0,
  });

  const overall = blank();
  const byShop = new Map<string, Tally>();
  /** maradek token -> mely boltokban fordult elo */
  const residue = new Map<string, Set<string>>();
  const residueCount = new Map<string, number>();
  const samples: Array<{ name: string; parsed: WineParseResult }> = [];

  for (const row of listings) {
    const parsed = parseWineName(row.raw_name, vocab);
    const shop = byShop.get(row.shop_key) ?? blank();
    if (!byShop.has(row.shop_key)) byShop.set(row.shop_key, shop);

    for (const t of [overall, shop]) {
      t.total++;
      if (parsed.producer) t.producer++;
      if (parsed.grapes.length) t.grape++;
      if (parsed.style) t.style++;
      if (parsed.region) t.region++;
      if (parsed.vineyard) t.vineyard++;
      // Az evjarat a nevbol VAGY a mar kinyert mezobol
      if (parsed.vintageValue !== null || row.vintage_value !== null) t.vintage++;
      if (parsed.ambiguous.length) t.ambiguous++;
      if (!parsed.expression) t.emptyResidue++;
      if (parsed.producer && parsed.grapes.length && parsed.style &&
          (parsed.vintageValue !== null || row.vintage_value !== null)) {
        t.allFour++;
      }
    }

    for (const tok of (parsed.expression ?? '').split(' ').filter(Boolean)) {
      if (tok.length < 3) continue;
      residueCount.set(tok, (residueCount.get(tok) ?? 0) + 1);
      const shops = residue.get(tok) ?? new Set<string>();
      shops.add(row.shop_key);
      residue.set(tok, shops);
    }

    if (samples.length < 15) samples.push({ name: row.raw_name, parsed });
  }

  process.stdout.write(`\n=== SLOT-KITOLTOTTSEG (${overall.total} listing) ===\n`);
  process.stdout.write(line('borászat', overall.producer, overall.total));
  process.stdout.write(line('szolofajta', overall.grape, overall.total));
  process.stdout.write(line('bortipus', overall.style, overall.total));
  process.stdout.write(line('evjarat', overall.vintage, overall.total));
  process.stdout.write(line('borvidek', overall.region, overall.total));
  process.stdout.write(line('dulo', overall.vineyard, overall.total));
  process.stdout.write('  ' + '-'.repeat(60) + '\n');
  process.stdout.write(line('mind a 4 azonossag', overall.allFour, overall.total));
  process.stdout.write(line('nincs maradek', overall.emptyResidue, overall.total));
  process.stdout.write(line('ketertelmuseg', overall.ambiguous, overall.total));

  process.stdout.write('\n=== BOLTONKENT ===\n');
  for (const [shop, t] of [...byShop.entries()].sort()) {
    process.stdout.write(`\n  ${shop}  (${t.total} listing)\n`);
    process.stdout.write(line('  borászat', t.producer, t.total));
    process.stdout.write(line('  szolofajta', t.grape, t.total));
    process.stdout.write(line('  bortipus', t.style, t.total));
    process.stdout.write(line('  mind a 4', t.allFour, t.total));
  }

  // A maradek tokenek: ez a borászatszotar nyersanyaga. A tobb boltban is
  // elofordulo tokenek a legerosebb jeloltek.
  const ranked = [...residueCount.entries()]
    .map(([token, count]) => ({ token, count, shops: residue.get(token)?.size ?? 0 }))
    .sort((a, b) => b.shops - a.shops || b.count - a.count)
    .slice(0, 50);

  process.stdout.write('\n=== MARADEK TOKENEK (borászat-jeloltek) ===\n');
  process.stdout.write('  A tobb boltban is elofordulo token az erosebb jelolt.\n\n');
  process.stdout.write('  ' + 'token'.padEnd(26) + 'elofordulas   bolt\n');
  for (const r of ranked) {
    process.stdout.write(`  ${r.token.padEnd(26)}${String(r.count).padStart(8)}${String(r.shops).padStart(7)}\n`);
  }

  // -- Marka-/boraszatoldalak: a szotar legjobb nyersanyaga -----------------
  //
  // A not_product statuszu sorok tobbsege a boltok MARKA-szuro oldala, ahol az
  // <h1> maga a boraszat kanonikus neve ("Gere Attila", "Takler Borbirtok").
  // Ez lenyegesen jobb alapanyag, mint a terméknevekbol banyaszott n-gram: itt
  // a bolt sajat, kuralt nevet adja.
  //
  // FIGYELEM: nem mind boraszat. Van kozottuk borvidek (Rueda, Treviso),
  // sorfozde, sot nem-ital marka (Maldon, Coravin) es kategoria is
  // ("Minden mas"). Ezert JAVASLAT, amit ember hagy jova.
  const brandPages = await query<{ shop_key: string; raw_name: string }>(
    `SELECT s.key AS shop_key, sl.raw_name
       FROM source_listings sl
       JOIN shops s ON s.id = sl.shop_id
      WHERE sl.listing_status = 'not_product'
        AND length(btrim(sl.raw_name)) BETWEEN 3 AND 60
      ORDER BY s.key, sl.raw_name`,
  );

  if (brandPages.length) {
    const seen = new Set<string>();
    const uniq = brandPages.filter((b) => {
      const k = b.raw_name.trim().toLowerCase();
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    process.stdout.write(`\n=== MARKA-/BORASZATOLDALAK (${uniq.length} egyedi nev) ===\n`);
    process.stdout.write('  A not_product oldalak nevei: boraszatjelolt-nyersanyag.\n\n');
    for (const b of uniq.slice(0, 250)) {
      process.stdout.write(`  ${b.shop_key.padEnd(14)}${b.raw_name}\n`);
    }
    if (uniq.length > 250) process.stdout.write(`  ... es meg ${uniq.length - 250} nev\n`);
  }


  process.stdout.write('\n=== MINTA FELBONTASOK ===\n');
  for (const s of samples) {
    const p = s.parsed;
    process.stdout.write(`\n  "${s.name}"\n`);
    process.stdout.write(
      `    borászat=${p.producer?.canonicalName ?? '-'}  ` +
      `fajta=${p.grapes.map((g) => g.canonicalName).join('+') || '-'}  ` +
      `tipus=${p.style?.canonicalName ?? '-'}  ` +
      `evjarat=${p.vintageValue ?? '-'}\n`,
    );
    process.stdout.write(
      `    borvidek=${p.region?.canonicalName ?? '-'}  ` +
      `dulo=${p.vineyard?.canonicalName ?? '-'}  ` +
      `maradek="${p.expression ?? ''}"\n`,
    );
  }
  process.stdout.write('\n');
}

main()
  .catch((err) => {
    process.stderr.write(`\nA riport nem futott le:\n${err instanceof Error ? err.message : String(err)}\n\n`);
    process.exitCode = 1;
  })
  .finally(() => void closeDb());
