/**
 * Emberi parositasok atmentese, ha egy bolt URL-semaja megvaltozik.
 *
 * A winehubnal ez elesben megtortent. A bolt rossz adapterrel (Shopify) volt
 * konfiguralva, ezert a rendszer HTML-t olvasott, es a magyar meg az angol
 * oldalakat vegyesen gyujtotte be. A WooCommerce Store API-ra allas utan a
 * felderites a MAGYAR katalogust hozta - uj URL-eken, uj sorokban:
 *
 *   3 696 regi sor  ->  missing        (ebbol 1 506 angol nyelvu URL)
 *   1 438 uj sor    ->  active, valodi arral
 *   1 438 kozos cikkszam                <- MINDEN uj sornak van regi parja
 *
 * A termekek tehat nem tuntek el: mas nevet kaptak a nyilvantartasban. A
 * 537 igazolt parositas viszont a REGI sorokon logott, es ezzel egy csapasra
 * hasznalhatatlanna valt volna.
 *
 * Ezt a munkat nem szabad eldobni. Egy ember 537-szer nezett meg ket bort es
 * mondta ki, hogy ugyanaz - ez a rendszer legdragabb adata.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * Mikor telepitunk at egy parositast?
 *
 * Csak akkor, ha a cikkszam alapjan EGYERTELMU a megfelelés:
 *
 *   - az uj sor aktiv, a regi mar nem;
 *   - ugyanabban a boltban vannak;
 *   - a cikkszam megegyezik;
 *   - es a regi sorok EGYETLEN kanonikus valtozatra mutatnak.
 *
 * Ha ket regi sor ket kulonbozo valtozathoz volt kotve, nem talalgatunk:
 * azt a cikkszamot kihagyjuk, es kiirjuk. Az ember dontese nem hig.
 *
 * A regi kapcsolat nem torlodik, csak lezarul (`valid_to`), es az uj mellé
 * egy `match_decisions` sor kerul, ami megmondja, honnan szarmazik. A dontes
 * igy visszakovetheto marad.
 *
 *   npm run ops:relink-listings -- --shop winehub            -- csak megmutatja
 *   npm run ops:relink-listings -- --shop winehub --write    -- eles futas
 */
import { closeDb, initDb, query, queryOne, transaction } from '@radovin/db';
import { configureLogger } from '@radovin/observability';

function argValue(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? (process.argv[i + 1] ?? null) : null;
}

interface Jelolt {
  sku: string;
  newListingId: string;
  newName: string;
  newIdentityHash: string | null;
  variantIds: string[];
  oldRelationIds: string[];
  variantName: string | null;
}

async function main(): Promise<void> {
  configureLogger({ level: 'warn', pretty: true, service: 'relink-listings' });
  const url = process.env['DATABASE_URL'];
  if (!url) throw new Error('A DATABASE_URL kornyezeti valtozo kotelezo.');
  initDb({ connectionString: url, max: 4, applicationName: 'radovin-relink' });

  const write = process.argv.includes('--write');
  const shopKey = argValue('shop');
  if (!shopKey) throw new Error('Add meg a boltot: --shop <kulcs>');

  const shop = await queryOne<{ id: string; name: string }>(
    'SELECT id::text, name FROM shops WHERE key = $1', [shopKey],
  );
  if (!shop) throw new Error(`Nincs ilyen bolt: ${shopKey}`);

  console.log(`\n══ PAROSITASOK ATMENTESE · ${shop.name} ═══════════════════════════════\n`);

  // Cikkszamonkent: melyik AKTIV sorhoz melyik lezart sorok parositasai
  // tartoznak. A `variant_ids` tombbol derul ki, egyertelmu-e a megfeleles.
  const jeloltek = await query<Jelolt>(
    `WITH aktiv AS (
       SELECT sl.id, sl.sku, sl.raw_name, sl.identity_hash
         FROM source_listings sl
        WHERE sl.shop_id = $1 AND sl.listing_status = 'active' AND sl.sku IS NOT NULL
     ),
     regi AS (
       SELECT sl.sku, mr.id AS relation_id, mr.canonical_variant_id
         FROM source_listings sl
         JOIN match_relations mr ON mr.source_listing_id = sl.id
        WHERE sl.shop_id = $1 AND sl.listing_status <> 'active' AND sl.sku IS NOT NULL
          AND mr.valid_to IS NULL AND mr.status = 'verified'
     )
     SELECT a.sku,
            a.id::text                                   AS "newListingId",
            a.raw_name                                   AS "newName",
            a.identity_hash                              AS "newIdentityHash",
            array_agg(DISTINCT r.canonical_variant_id::text) AS "variantIds",
            array_agg(DISTINCT r.relation_id::text)          AS "oldRelationIds",
            min(cv.canonical_display_name)               AS "variantName"
       FROM aktiv a
       JOIN regi r ON r.sku = a.sku
       LEFT JOIN canonical_variants cv ON cv.id = r.canonical_variant_id
      WHERE NOT EXISTS (
        SELECT 1 FROM match_relations m2
         WHERE m2.source_listing_id = a.id AND m2.valid_to IS NULL AND m2.status = 'verified'
      )
      GROUP BY a.sku, a.id, a.raw_name, a.identity_hash
      ORDER BY a.raw_name`,
    [shop.id],
  );

  const egyertelmu = jeloltek.filter((j) => j.variantIds.length === 1);
  const ketes = jeloltek.filter((j) => j.variantIds.length > 1);

  console.log(`  ${egyertelmu.length} parositas menthető at egyertelmuen`);
  if (ketes.length) {
    console.log(`  ${ketes.length} cikkszamnal TOBB kanonikus valtozat - ezeket kihagyjuk:`);
    for (const j of ketes.slice(0, 10)) {
      console.log(`    ${j.sku.padEnd(20)} ${j.variantIds.length} valtozat  ${j.newName}`);
    }
  }

  if (!egyertelmu.length) {
    console.log('\n  Nincs mit atmenteni.\n');
    await closeDb();
    return;
  }

  console.log('\n  Peldak:');
  for (const j of egyertelmu.slice(0, 5)) {
    console.log(`    ${j.sku.padEnd(20)} ${(j.variantName ?? '?').slice(0, 44)}`);
  }

  if (!write) {
    console.log('\n  A regi kapcsolat nem torlodik, csak lezarul - a dontes visszakovetheto marad.');
    console.log('\n  Az eles futashoz: -- --write\n');
    await closeDb();
    return;
  }

  let atmentve = 0;
  for (const j of egyertelmu) {
    const variantId = j.variantIds[0]!;
    await transaction(async (client) => {
      // A regi kapcsolatok lezarasa. Muszaj eloszor: egy listinghez egyszerre
      // csak EGY aktiv verified kapcsolat tartozhat, es ugyanaz a par is
      // csak egyszer szerepelhet aktivan.
      await client.query(
        `UPDATE match_relations SET valid_to = now(), updated_at = now()
          WHERE id = ANY($1::uuid[]) AND valid_to IS NULL`,
        [j.oldRelationIds],
      );

      const forras = await client.query<{
        decision_origin: string; verified_kind: string | null; confidence: string | null;
        locked_by_human: boolean; last_verified_at: string | null;
        matcher_version: string | null; taxonomy_version: string | null;
        policy_version: string | null; old_decision_id: string | null;
      }>(
        `SELECT mr.decision_origin, mr.verified_kind, mr.confidence, mr.locked_by_human,
                mr.last_verified_at, mr.current_decision_id::text AS old_decision_id,
                d.matcher_version, d.taxonomy_version, d.policy_version
           FROM match_relations mr
           LEFT JOIN match_decisions d ON d.id = mr.current_decision_id
          WHERE mr.id = $1`,
        [j.oldRelationIds[0]],
      );
      const f = forras.rows[0]!;

      const rel = await client.query<{ id: string }>(
        `INSERT INTO match_relations
           (canonical_variant_id, source_listing_id, shop_id, status, decision_origin,
            verified_kind, confidence, locked_by_human, identity_hash_at_decision,
            last_verified_at)
         VALUES ($1,$2,$3,'verified',$4,$5,$6,$7,$8,$9)
         RETURNING id::text`,
        [
          variantId, j.newListingId, shop.id, f.decision_origin,
          f.verified_kind, f.confidence, f.locked_by_human,
          // A dontes ugyanarra a TERMEKRE vonatkozik, csak mas soron all.
          // Az uj sor azonossagat rogzitjuk, kulonben a driftfigyelo azonnal
          // eltolodast jelezne egy valojaban valtozatlan parositasra.
          j.newIdentityHash,
          f.last_verified_at,
        ],
      );
      const relationId = rel.rows[0]!.id;

      const dec = await client.query<{ id: string }>(
        `INSERT INTO match_decisions
           (match_relation_id, canonical_variant_id, source_listing_id, shop_id, status,
            matcher_version, taxonomy_version, policy_version, reason_codes,
            explanation_hu, decision_json, decided_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,'system')
         RETURNING id::text`,
        [
          relationId, variantId, j.newListingId, shop.id,
          f.verified_kind === 'human_verified' ? 'human_verified' : 'auto_verified',
          f.matcher_version ?? 'relink', f.taxonomy_version ?? 'relink',
          f.policy_version ?? 'relink',
          ['LISTING_RELINKED'],
          'A bolt URL-semaja megvaltozott, a termek uj soron all. A korabbi '
          + `dontes cikkszam alapjan (${j.sku}) atkerult az uj sorra.`,
          JSON.stringify({
            relinkedFromRelationIds: j.oldRelationIds,
            previousDecisionId: f.old_decision_id,
            sku: j.sku,
          }),
        ],
      );

      await client.query(
        'UPDATE match_relations SET current_decision_id = $2 WHERE id = $1',
        [relationId, dec.rows[0]!.id],
      );

      // A valtozat-bolt allapot is az uj sorra mutasson, kulonben a
      // publikalas es a kutatas tovabbra is a lezart sort keresne.
      await client.query(
        `UPDATE variant_shop_status
            SET matched_listing_id = $3, updated_at = now()
          WHERE canonical_variant_id = $1 AND shop_id = $2`,
        [variantId, shop.id, j.newListingId],
      );
    });
    atmentve++;
  }

  console.log(`\n  ${atmentve} parositas atkerult az uj sorokra.`);
  console.log('\n  A piaci oldal a kovetkezo publikalastol mutatja oket:');
  console.log('    Folyamatkezeles -> "Ar-osszehasonlitas ujraepitese"\n');

  await closeDb();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
