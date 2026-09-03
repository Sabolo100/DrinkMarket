/**
 * A mar megnyitott parositasi esetek ujraertekelesenek elinditasa.
 *
 * Amikor bekapcsolod az automatikus jovahagyast - vagy jovahagysz egy csomo
 * boraszatot -, a MAR NYITOTT esetek nem ertekelodnek ujra maguktol. A
 * `variant_shop_status.next_search_at` a korabbi dontes szerint van beallitva
 * (needs_review eseten 14 nap), es az `unmatched-research` job csak a lejart
 * sorokat veszi elo.
 *
 * Ez a parancs elorehozza azokat a sorokat, amikre a valtozas hathat. Utana
 * a scheduler sajat utemben, kotegenkent (200) dolgozza fel oket - nem
 * inditunk semmit kozvetlenul, tehat nem terheljuk tul a rendszert.
 *
 * Amit NEM erint: a mar igazolt (`auto_verified`, `human_verified`) es a
 * felfuggesztett sorok. Egy emberi dontest ez nem birál felul.
 *
 *   npm run ops:recheck            -- csak a szamokat mutatja
 *   npm run ops:recheck -- --write -- eles: elorehozza a kereseseket
 */
import { closeDb, execute, initDb, query } from '@radovin/db';
import { configureLogger } from '@radovin/observability';

/** Ezeket sosem hozzuk elore: emberi vagy mar lezart allapotok. */
const KEEP = ['auto_verified', 'human_verified', 'suspended'];

async function main(): Promise<void> {
  configureLogger({ level: 'warn', pretty: true, service: 'recheck' });
  const url = process.env['DATABASE_URL'];
  if (!url) throw new Error('A DATABASE_URL kornyezeti valtozo kotelezo.');
  initDb({ connectionString: url, max: 4, applicationName: 'radovin-recheck' });

  const write = process.argv.includes('--write');

  const rows = await query<{ status: string; count: number; kesobb: number }>(
    `SELECT status, count(*)::int AS count,
            count(*) FILTER (WHERE next_search_at > now())::int AS kesobb
       FROM variant_shop_status
      WHERE status <> ALL($1::text[])
      GROUP BY status ORDER BY count(*) DESC`,
    [KEEP],
  );

  console.log('\n══ UJRAERTEKELHETO VALTOZAT-BOLT PAROK ══════════════════════════════════\n');
  let total = 0;
  let pending = 0;
  for (const r of rows) {
    console.log(`  ${r.status.padEnd(34)} ${String(r.count).padStart(7)}   ebbol meg var: ${r.kesobb}`);
    total += r.count;
    pending += r.kesobb;
  }
  if (!total) {
    console.log('  (nincs ilyen sor)');
  }

  const cases = await query<{ count: number }>(
    `SELECT count(*)::int AS count FROM review_cases WHERE status = 'open'`,
  );

  console.log(`\n  osszesen ${total} sor, ebbol ${pending} varna meg a menetrend szerint`);
  console.log(`  nyitott ellenorzesi eset: ${cases[0]?.count ?? 0}`);

  if (!write) {
    console.log('\n  Semmi nem valtozott. Az eles futashoz: -- --write');
    console.log('  Utana a scheduler kotegenkent (200) dolgozza fel oket.');
    console.log('  Amit a gep kozben biztosra vesz, annak a nyitott esete magatol lezarul.\n');
    await closeDb();
    return;
  }

  const updated = await execute(
    `UPDATE variant_shop_status
        SET next_search_at = now()
      WHERE status <> ALL($1::text[])
        AND (next_search_at IS NULL OR next_search_at > now())`,
    [KEEP],
  );

  console.log(`\n  ${updated} sor kereses elorehozva.`);
  console.log('  A scheduler a kovetkezo korben elkezdi, kotegenkent 200-at.');
  console.log('  A nyitott esetek akkor zarulnak, amikor a gep biztosra veszi oket.\n');

  await closeDb();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
