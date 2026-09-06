/**
 * Boltonkent: nem szivargott-e be EGYETLEN ertek arkent?
 *
 * A valos rendszerben egy webshop 3 696 termekebol 3 661 kapott pontosan
 * 15 000 Ft-ot. Harom es fel ezer teljesen kulonbozo bor, egyetlen aron - a
 * maradek nehany (3 667, 2 227, 4 900) viszont valosnak latszott.
 *
 * Ez a mintazat egyetlen dolgot jelenthet: nem a termek arat olvassuk, hanem
 * valami mast, ami minden oldalon ugyanaz. Jellemzoen a szallitasi kuszobot.
 *
 * A szovegszuro ("Ingyenes szallitas 15 000 Ft felett") csak a DOM-agat
 * vedte, a bolt tobbsegenel viszont a JSON-LD nyert. Minden uj kinyeresi ut
 * uj ajtot nyit ugyanannak a hibanak - ezert kell egy szabaly, ami nem a
 * szoveget nezi, hanem az EREDMENYT.
 *
 * A jeloles nem torol es nem ir felul arat: csak kimondja, hogy nem
 * osszehasonlithato. Igy a piaci oldalra nem kerul ki, de az adat megmarad.
 * Egy kesobbi, helyes kinyeres uj sort ir, tehat a jeloles magatol elavul.
 *
 *   npm run ops:price-audit            -- csak megmutatja
 *   npm run ops:price-audit -- --write -- eles futas
 */
import { closeDb, initDb, query } from '@radovin/db';
import { configureLogger } from '@radovin/observability';
import { detectUniformPrice, flagUniformPrice } from '../lib/price-audit.js';

async function main(): Promise<void> {
  configureLogger({ level: 'warn', pretty: true, service: 'price-audit' });
  const url = process.env['DATABASE_URL'];
  if (!url) throw new Error('A DATABASE_URL kornyezeti valtozo kotelezo.');
  initDb({ connectionString: url, max: 4, applicationName: 'radovin-price-audit' });

  const write = process.argv.includes('--write');

  const shops = await query<{ id: string; key: string }>(
    `SELECT id::text, key FROM shops WHERE active AND NOT policy_disabled ORDER BY key`,
  );

  console.log('\n══ EGYENAR-VIZSGALAT WEBSHOPONKENT ══════════════════════════════════════\n');

  let found = 0;
  let flagged = 0;

  for (const shop of shops) {
    const finding = await detectUniformPrice(shop.id);
    if (!finding) {
      console.log(`  ${shop.key.padEnd(14)} rendben`);
      continue;
    }
    found++;
    const pct = Math.round(finding.share * 100);
    console.log(
      `  ${shop.key.padEnd(14)} ${String(finding.price).padStart(7)} Ft`
      + `  ${String(finding.affected).padStart(5)} / ${finding.total} termeken  (${pct}%)`,
    );

    if (write) {
      flagged += await flagUniformPrice(shop.id, finding);
    }
  }

  if (!found) {
    console.log('\n  Egyetlen boltnal sem talaltunk egyenarat.\n');
    await closeDb();
    return;
  }

  if (!write) {
    console.log('\n  Ezek az arak NEM termekarak: egy ertek szivargott be minden oldalrol.');
    console.log('  A jeloles nem torol semmit - csak kizarja oket az osszehasonlitasbol.');
    console.log('\n  Az eles futashoz: -- --write\n');
    await closeDb();
    return;
  }

  console.log(`\n  ${flagged} ajanlat kizarva az osszehasonlitasbol.`);
  console.log('\n  A piaci oldal a kovetkezo publikalastol lesz tiszta:');
  console.log('    Folyamatkezeles -> "Ar-osszehasonlitas ujraepitese"');
  console.log('\n  A valodi arakhoz a bolt ujrafelderitese kell - ha a webshop');
  console.log('  blokkolja a crawlert, azt elobb rendezni kell.\n');

  await closeDb();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
