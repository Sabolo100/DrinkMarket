/**
 * Szarazpróba: mit valtoztatna az ujrakinyeres a katalogusen?
 *
 * A `/boraszatok` feluletrol az alkalmazas egy gombnyomas, de az ELOTT
 * erdemes latni, mekkora valtozas johet. Ez a parancs semmit nem ir - csak
 * megszamolja, hany listingen ismerne fel a rendszer a jovahagyott
 * boraszatokat, es mit tenne a mezokkel.
 *
 * Fejlesztoi gepen `npm run wine:apply`, a futtato konteneren `ops:apply` -
 * ott nincs `tsx`, mert a runtime image `--omit=dev`-vel epul.
 *
 *   ... (nincs kapcsolo)  csak a meg nem alkalmazott jovahagyasok
 *   ... -- --all          minden aktiv boraszat
 *   ... -- --write        ELES futas: ir is
 */
import { closeDb, initDb, query } from '@radovin/db';
import { configureLogger } from '@radovin/observability';
import { loadWorkerConfig } from '../config.js';
import { processReextract, type ReextractPayload } from '../processors/reextract.js';

function arg(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

async function main(): Promise<void> {
  configureLogger({ level: 'info', pretty: true, service: 'wine-apply' });
  const config = loadWorkerConfig();
  initDb({
    connectionString: config.databaseUrl,
    ssl: process.env['DATABASE_SSL'] === 'true',
    max: 4,
    applicationName: 'radovin-wine-apply',
  });

  const all = arg('all');
  const write = arg('write');

  const producers = await query<{ status: string; applied: number; count: number }>(
    `SELECT status,
            count(*) FILTER (WHERE applied_at IS NOT NULL)::int AS applied,
            count(*)::int AS count
       FROM producers GROUP BY status ORDER BY status`,
  );
  console.log('\nBorászatok állapota');
  for (const p of producers) {
    const extra = p.status === 'active' ? `  (alkalmazva: ${p.applied})` : '';
    console.log(`  ${p.status.padEnd(10)} ${String(p.count).padStart(5)}${extra}`);
  }

  const payload: ReextractPayload = {
    ...(all ? { all: true } : { pendingOnly: true }),
    dryRun: !write,
    cluster: write,
  };

  console.log(`\n${write ? 'ÉLES FUTÁS' : 'Szárazpróba'} — ${all ? 'minden jóváhagyott' : 'csak a még nem alkalmazott'} borászat\n`);

  const job = { data: payload } as Parameters<typeof processReextract>[0];
  const result = await processReextract(job, config) as Record<string, unknown>;

  console.log(JSON.stringify(result, null, 2));

  if (!write) {
    console.log('\nSemmi nem íródott ki. Az éles futáshoz: npm run wine:apply -- --write');
  }
  await closeDb();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
