/**
 * Ha egy webshop termekeinek tulnyomo resze UGYANAZT az arat kapja, akkor az
 * nem ar.
 *
 * A valos rendszerben egy bolt 3 696 termekebol 3 661 kapott pontosan
 * 15 000 Ft-ot - Borbely Rozsako, Folly Olaszrizling, es meg harom es fel
 * ezer teljesen kulonbozo bor. A maradek nehany (3 667, 2 227, 4 900)
 * valosnak latszott, tehat a kinyeres neha helyesen dolgozott.
 *
 * Ez a mintazat egyetlen dolgot jelenthet: nem a termek arat olvassuk, hanem
 * valami mast, ami minden oldalon ugyanaz. Jellemzoen a szallitasi kuszobot
 * ("Ingyenes szallitas 15 000 Ft felett").
 *
 * ────────────────────────────────────────────────────────────────────────────
 * Miert kell ez, ha mar van szovegszuro?
 *
 * Mert a szovegszuro a DOM-agat vedi, es a bolt tobbsegenel a JSON-LD nyert.
 * Minden uj kinyeresi ut uj ajtot nyit ugyanannak a hibanak - a
 * SZOVEGMINTAK vedelme mindig egy lepessel a valosag mogott jar.
 *
 * Ez a szabaly viszont nem a szoveget nezi, hanem az EREDMENYT. Fuggetlen
 * attol, honnan jott az ar, es fuggetlen a bolt sablonjatol.
 *
 * Amit NEM tesz: nem torol es nem ir felul arat. Csak azt mondja ki, hogy
 * "ez nem osszehasonlithato" - igy a piaci oldalra nem kerul ki, de az adat
 * es a diagnozis megmarad.
 */
import { execute, query } from '@radovin/db';
import { logger } from '@radovin/observability';

/**
 * Ennyi termek felett vizsgalodunk. Kis katalogusnal a veletlen egybeeses
 * meg eletszeru - harom borbol ketto lehet ugyanannyi.
 */
const MIN_LISTINGS = 20;

/**
 * Ekkora aranytol mondjuk ki, hogy nem ar.
 *
 * Bornal ez bosegesen biztonsagos: egy valodi borkatalogusban a leggyakoribb
 * ar tipikusan a tetelek nehany szazalekat fedi. A fele mar nem lehet
 * veletlen.
 */
const UNIFORM_SHARE = 0.5;

export interface UniformPriceFinding {
  shopKey: string;
  price: number;
  affected: number;
  total: number;
  share: number;
}

/** A bolt leggyakoribb ara es annak aranya - iras nelkul. */
export async function detectUniformPrice(shopId: string): Promise<UniformPriceFinding | null> {
  const rows = await query<{
    shop_key: string; price: string | null; db: number; total: number;
  }>(
    `WITH aktiv AS (
       SELECT s.key AS shop_key, o.selected_comparable_price_huf AS price
         FROM source_listings sl
         JOIN shops s ON s.id = sl.shop_id
         JOIN offer_observations o ON o.id = sl.latest_offer_id
        WHERE sl.shop_id = $1
          AND sl.listing_status = 'active'
          AND o.comparable
          AND o.selected_comparable_price_huf > 0
     )
     SELECT shop_key, price::text, count(*)::int AS db,
            (SELECT count(*)::int FROM aktiv) AS total
       FROM aktiv
      GROUP BY shop_key, price
      ORDER BY count(*) DESC
      LIMIT 1`,
    [shopId],
  );

  const top = rows[0];
  if (!top?.price || top.total < MIN_LISTINGS) return null;

  const share = top.db / top.total;
  if (share < UNIFORM_SHARE) return null;

  return {
    shopKey: top.shop_key,
    price: Number(top.price),
    affected: top.db,
    total: top.total,
    share,
  };
}

/**
 * A talalt egyenar kizarasa az osszehasonlitasbol.
 *
 * Csak a MOSTANI ajanlatokat jeloli meg. Egy kesobbi, helyes kinyeres uj
 * `offer_observations` sort ir, tehat a jeloles magatol elavul - nem kell
 * visszavonni.
 */
export async function flagUniformPrice(
  shopId: string,
  finding: UniformPriceFinding,
): Promise<number> {
  const affected = await execute(
    `UPDATE offer_observations o
        SET comparable = false,
            price_type = 'not_comparable',
            not_comparable_reason = $3
      FROM source_listings sl
      WHERE sl.latest_offer_id = o.id
        AND sl.shop_id = $1
        AND sl.listing_status = 'active'
        AND o.selected_comparable_price_huf = $2
        AND o.comparable`,
    [
      shopId, finding.price,
      `A webshop termekeinek ${Math.round(finding.share * 100)}%-a ugyanezt az `
      + 'erteket kapta arkent - ez nem termekar, hanem valoszinuleg szallitasi kuszob.',
    ],
  );

  logger.warn('price.uniform_shop_price', {
    shopKey: finding.shopKey, price: finding.price,
    affected, total: finding.total,
    share: Math.round(finding.share * 100) / 100,
    hint: 'Az erintett arak nem kerulnek a piaci oldalra.',
  });

  return affected;
}

/** Felismeres es jeloles egy lepesben - ezt hivja a crawl futas vege. */
export async function auditShopPrices(shopId: string): Promise<UniformPriceFinding | null> {
  const finding = await detectUniformPrice(shopId);
  if (!finding) return null;
  await flagUniformPrice(shopId, finding);
  return finding;
}
