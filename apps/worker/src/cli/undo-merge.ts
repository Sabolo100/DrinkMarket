/**
 * Egy boraszat-osszevonas visszabontasa.
 *
 * Az osszevonas harom nyomot hagy:
 *
 *   1. a beolvadt sorok `merged` allapotot es `merged_into_id`-t kapnak
 *   2. a nevukbol JOVAHAGYOTT aliasz lesz a tulelon
 *   3. az idegen kulcsok (listing, csalad, marka, dulo) atkerulnek
 *
 * A masodik az, ami karos tud lenni. Ha egy TERMEKNEVET olvasztottunk be
 * ("Sauska Brut"), az aliasz megmergezi a szotarat: az a leghosszabb egyezes
 * szerint rendez, tehat a `brut` szot termelonevkent nyeli el - es onnantol a
 * pezsgo-felismeres soha nem latja. A tetelnev is elveszti azt a szot, ami
 * megkulonbozteti a tobbi tetelrol.
 *
 * Ez a parancs a 2. es az 1. lepest vonja vissza. A 3.-at NEM: ha egy sornak
 * voltak termekei, azok mar a tulelon vannak, es visszamozgatni oket vak
 * talalgatas lenne. Ezert a parancs kizarolag azokat a sorokat bontja vissza,
 * amiknek NEM volt termeke - epp azokat, ahol a beolvasztas csak aliaszt
 * gyartott.
 *
 *   npm run ops:undo-merge -- --keep "Sauska"            -- csak megmutatja
 *   npm run ops:undo-merge -- --keep "Sauska" --write    -- eles futas
 */
import { closeDb, execute, initDb, query } from '@radovin/db';
import { configureLogger } from '@radovin/observability';

function argValue(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? (process.argv[i + 1] ?? null) : null;
}

async function main(): Promise<void> {
  configureLogger({ level: 'warn', pretty: true, service: 'undo-merge' });
  const url = process.env['DATABASE_URL'];
  if (!url) throw new Error('A DATABASE_URL kornyezeti valtozo kotelezo.');
  initDb({ connectionString: url, max: 4, applicationName: 'radovin-undo-merge' });

  const write = process.argv.includes('--write');
  const keepName = argValue('keep');

  if (!keepName) {
    console.log('\n  Meg kell adni, MELYIK boraszatba olvadtak be a sorok:');
    console.log('    npm run ops:undo-merge -- --keep "Sauska"\n');
    await closeDb();
    return;
  }

  const keep = (await query<{ id: string; canonical_name: string }>(
    `SELECT id::text, canonical_name FROM producers
      WHERE rv_search_norm(canonical_name) = rv_search_norm($1) AND status <> 'merged'
      LIMIT 1`,
    [keepName],
  ))[0];

  if (!keep) {
    console.log(`\n  Nincs ilyen boraszat: "${keepName}"\n`);
    await closeDb();
    return;
  }

  console.log('\n══ OSSZEVONAS VISSZABONTASA ═════════════════════════════════════════════\n');
  console.log(`  Tulelo: ${keep.canonical_name}\n`);

  // Kizarolag azok a sorok, amik EBBE a boraszatba olvadtak, es amiknek NINCS
  // termekuk. Ahol termek is atkerult, ott a visszabontas talalgatas lenne.
  const rows = await query<{
    id: string; canonical_name: string; alias_id: string | null; moved: number;
  }>(
    `SELECT p.id::text, p.canonical_name,
            a.id::text AS alias_id,
            (SELECT count(*)::int FROM source_listings sl WHERE sl.producer_id = p.id) AS moved
       FROM producers p
       LEFT JOIN aliases a
         ON a.alias_type = 'producer' AND a.target_kind = 'producer'
        AND a.target_id = $1
        AND a.alias_norm = p.name_norm
        AND a.evidence @> '[{"kind":"producer_merge"}]'::jsonb
      WHERE p.status = 'merged' AND p.merged_into_id = $1
      ORDER BY p.canonical_name`,
    [keep.id],
  );

  if (!rows.length) {
    console.log('  Nincs ebbe a boraszatba beolvadt sor.\n');
    await closeDb();
    return;
  }

  let restorable = 0;
  for (const r of rows) {
    const mark = r.moved > 0 ? '  <- termeke van, NEM bontjuk vissza' : '';
    console.log(`    ${r.canonical_name.padEnd(30)} aliasz: ${r.alias_id ? 'van' : 'nincs'}${mark}`);
    if (r.moved === 0) restorable++;
  }

  console.log(`\n  visszabonthato sor:                       ${String(restorable).padStart(7)}`);

  if (!write) {
    console.log('\n  Semmi nem valtozott. Az eles futashoz: -- --write');
    console.log('  A sorok `retired` allapotba kerulnek - vagyis elvetve, ahogy');
    console.log('  szantad oket -, es az aliaszuk inaktivva valik.\n');
    await closeDb();
    return;
  }

  const ids = rows.filter((r) => r.moved === 0).map((r) => r.id);
  if (!ids.length) {
    console.log('\n  Nincs mit visszabontani.\n');
    await closeDb();
    return;
  }

  // 1. Az aliaszok INAKTIVALASA. Nem torles: az audit maradjon meg.
  const aliases = await execute(
    `UPDATE aliases SET active = false, approved = false
      WHERE alias_type = 'producer' AND target_kind = 'producer'
        AND target_id = $1
        AND evidence @> '[{"kind":"producer_merge"}]'::jsonb
        AND alias_norm IN (SELECT name_norm FROM producers WHERE id = ANY($2::uuid[]))`,
    [keep.id, ids],
  );

  // 2. A sorok `retired`-be - vagyis oda, ahova eredetileg szantad oket.
  const restored = await execute(
    `UPDATE producers
        SET status = 'retired', merged_into_id = NULL,
            notes = coalesce(notes || E'\\n', '')
                    || 'Osszevonas visszabontva: a tobblet nem boraszatnev.'
      WHERE id = ANY($1::uuid[])`,
    [ids],
  );

  // 3. A tulelo ujra "meg nem alkalmazott": a szotar valtozott, tehat a
  //    katalogust ujra vegig kell nezni - most mar a mergezo aliaszok nelkul.
  await execute(`UPDATE producers SET applied_at = NULL WHERE id = $1`, [keep.id]);

  console.log(`\n  ${aliases} aliasz inaktivalva, ${restored} sor elvetve.`);
  console.log('\n  KOVETKEZO LEPES - enelkul a katalogus a regi allapotot orzi:');
  console.log('    Folyamatkezeles -> "Ujrakinyeres (teljes)"');
  console.log('    majd            -> "Parositasok ujraertekelese"\n');

  await closeDb();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
