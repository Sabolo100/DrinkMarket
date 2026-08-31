/**
 * Demo-adatok betoltese a felulet ellenorzesehez es bemutatasahoz.
 *
 * Valos webshopok NEVEIT hasznalja, de KITALALT arakkal es fixture
 * listingekkel dolgozik - NEM tolt le semmit elo forrasbol.
 *
 * Futtatas:  DATABASE_URL=... npm run seed:demo
 */
import { closeDb, execute, initDb, query, queryOne } from '@radovin/db';
import { emptyIdentityFields, emptyPriceSnapshot, type NormalizedSourceListing } from '@radovin/contracts';
import { contentHash, identityHash, sourceFingerprint } from '@radovin/domain';
import { configureLogger } from '@radovin/observability';
import { persistListing } from '../../apps/worker/src/lib/persist.js';
import { evaluateVariantForShop, VARIANT_QUERY, type VariantRow } from '../../apps/worker/src/lib/matching.js';
import { getMatchPolicy, getTaxonomy } from '../../apps/worker/src/lib/shop.js';
import { rebuildAndPublish } from '../../apps/worker/src/lib/publish.js';

interface Offer {
  shop: string; name: string; price: number; regular?: number; stock?: boolean;
}

interface Product {
  category: string; producer: string; family: string; display: string;
  vintage: number | null; vintageStatus: string; volumeMl: number;
  age?: number | null; edition?: string | null; puttony?: number | null;
  dosage?: string | null; abv?: number | null; tracked?: boolean;
  offers: Offer[];
}

const HENDRICKS = 'Hendrick’s';

const PRODUCTS: Product[] = [
  {
    category: 'wine', producer: 'Gere Attila', family: 'Roka Pinot Noir',
    display: 'Gere Attila Róka Pinot Noir 2023 0,75 l',
    vintage: 2023, vintageStatus: 'vintage', volumeMl: 750, abv: 13.5, tracked: true,
    offers: [
      { shop: 'bortarsasag', name: 'Gere Attila Róka Pinot Noir 2023', price: 11490 },
      { shop: 'winelovers', name: 'Gere Róka Pinot Noir 2023 0,75l', price: 12900 },
      { shop: 'borhalo', name: 'Gere Attila - Róka Pinot Noir 2023', price: 12490, regular: 13990 },
      { shop: 'radovin', name: 'Gere Attila Róka Pinot Noir 2023', price: 13490 },
      { shop: 'winehub', name: 'Róka Pinot Noir 2023 - Gere', price: 16990 },
    ],
  },
  {
    category: 'wine', producer: 'Bock József', family: 'Ermitage Cuvee',
    display: 'Bock József Ermitage Cuvée 2019 0,75 l',
    vintage: 2019, vintageStatus: 'vintage', volumeMl: 750, abv: 14, tracked: true,
    offers: [
      { shop: 'bortarsasag', name: 'Bock József Ermitage 2019 0,75', price: 19500 },
      { shop: 'radovin', name: 'Bock Ermitage Cuvée 2019 0,75 l', price: 17990, regular: 19900 },
      { shop: 'borhalo', name: 'Bock Ermitage Cuvée 2019', price: 18900 },
    ],
  },
  {
    category: 'tokaji_aszu', producer: 'Disznókő', family: 'Tokaji Aszu',
    display: 'Disznókő Tokaji Aszú 6 puttonyos 2017 0,5 l',
    vintage: 2017, vintageStatus: 'vintage', volumeMl: 500, puttony: 6, abv: 11,
    offers: [
      { shop: 'bortarsasag', name: 'Disznókő Tokaji Aszú 6 puttonyos 2017', price: 15900 },
      { shop: 'radovin', name: 'Disznókő Aszú 6p 2017 0,5l', price: 16490 },
    ],
  },
  {
    category: 'whisky', producer: 'Johnnie Walker', family: 'Black Label',
    display: 'Johnnie Walker Black Label 12 éves 0,7 l',
    vintage: null, vintageStatus: 'not_applicable', volumeMl: 700, age: 12,
    edition: 'black label', abv: 40,
    offers: [
      { shop: 'whiskynet', name: 'Johnnie Walker Black Label 12 éves 0,7l', price: 10490 },
      { shop: 'idrinks', name: 'Johnnie Walker Black Label 0,7 l 40%', price: 9990 },
      { shop: 'goodspirit', name: 'Johnnie Walker Black Label 12 YO', price: 11290 },
      { shop: 'mralkohol', name: 'Johnnie Walker Black Label whisky 0,7l', price: 9790, regular: 10990 },
      { shop: 'italshop', name: 'Johnnie Walker Black Label 12 éves', price: 12490, stock: false },
    ],
  },
  {
    category: 'whisky', producer: 'Johnnie Walker', family: 'Double Black',
    display: 'Johnnie Walker Double Black 0,7 l',
    vintage: null, vintageStatus: 'not_applicable', volumeMl: 700,
    edition: 'double black', abv: 40,
    offers: [
      { shop: 'whiskynet', name: 'Johnnie Walker Double Black 0,7l', price: 13990 },
      { shop: 'goodspirit', name: 'Johnnie Walker Double Black whisky', price: 14490 },
    ],
  },
  {
    category: 'champagne', producer: 'Moët & Chandon', family: 'Brut Imperial',
    display: 'Moët & Chandon Brut Impérial NV 0,75 l',
    vintage: null, vintageStatus: 'non_vintage', volumeMl: 750, dosage: 'brut', abv: 12,
    offers: [
      { shop: 'bortarsasag', name: 'Moët & Chandon Brut Impérial 0,75', price: 24900 },
      { shop: 'winelovers', name: 'Moet Chandon Brut Imperial pezsgő', price: 23490 },
      { shop: 'radovin', name: 'Moët & Chandon Brut Impérial NV', price: 25990 },
      { shop: 'winehub', name: 'Moët Brut Impérial 0,75 l', price: 26500 },
    ],
  },
  {
    category: 'palinka', producer: 'Bestillo', family: 'Szilva Palinka',
    display: 'Bestillo Szilva Pálinka 0,5 l',
    vintage: null, vintageStatus: 'not_applicable', volumeMl: 500, abv: 40,
    offers: [
      { shop: 'idrinks', name: 'Bestillo Szilvapálinka 0,5l 40%', price: 8490 },
      { shop: 'mralkohol', name: 'Bestillo szilva pálinka 0,5 l', price: 7990 },
      { shop: 'radovin', name: 'Bestillo Szilva Pálinka 0,5l', price: 8990 },
    ],
  },
  {
    category: 'gin', producer: HENDRICKS, family: 'Hendricks Gin',
    display: `${HENDRICKS} Gin 0,7 l`,
    vintage: null, vintageStatus: 'not_applicable', volumeMl: 700, abv: 41.4,
    offers: [
      { shop: 'idrinks', name: `${HENDRICKS} Gin 0,7 l 41,4%`, price: 12990 },
      { shop: 'goodspirit', name: `${HENDRICKS} Gin 0,7l`, price: 13490 },
      { shop: 'italshop', name: 'Hendricks gin 0,7 liter', price: 12490 },
    ],
  },
];

function makeListing(
  offer: Offer, p: Product, producerId: string | null, platformId: string,
): NormalizedSourceListing {
  const identity = {
    ...emptyIdentityFields(),
    categoryKey: p.category,
    producerId,
    producer: p.producer,
    expression: p.family.toLowerCase(),
    vintageValue: p.vintage,
    vintageStatus: p.vintageStatus as never,
    ageStatementYears: p.age ?? null,
    volumeMl: p.volumeMl,
    packCount: 1,
    packagingType: 'standard' as never,
    edition: p.edition ?? null,
    dosageStyle: p.dosage ?? null,
    puttony: p.puttony ?? null,
    abvPercent: p.abv ?? null,
  };

  const stock = offer.stock ?? true;
  const price = { ...emptyPriceSnapshot() };
  price.currentPriceHuf = offer.price;
  price.regularPriceHuf = offer.regular ?? offer.price;
  if (offer.regular && offer.regular > offer.price) price.salePriceHuf = offer.price;
  price.selectedComparablePriceHuf = offer.price;
  price.priceType = offer.regular && offer.regular > offer.price ? 'sale' : 'regular';
  price.comparable = true;
  price.inStock = stock;
  price.vatIncluded = true;

  const slug = offer.name.toLowerCase().normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const url = `https://${offer.shop}.hu/termek/${slug}`;
  const now = new Date().toISOString();

  return {
    shopKey: offer.shop,
    canonicalUrl: url,
    urlKey: `${offer.shop}.hu/termek/${slug}`,
    finalUrl: url,
    platformProductId: platformId,
    platformVariantId: null,
    sku: null,
    gtin: null,
    rawName: offer.name,
    rawBrand: p.producer,
    rawCategoryPath: [p.category],
    imageUrl: null,
    descriptionExcerpt: null,
    identity,
    price,
    availabilityStatus: stock ? 'in_stock' : 'out_of_stock',
    evidence: {
      name: {
        field: 'name', normalized_value: offer.name, raw_value: offer.name,
        source_location: 'demo.platform.name', source_excerpt: offer.name,
        method: 'platform_api', confidence: 0.99, observed_at: now,
      },
      volumeMl: {
        field: 'volumeMl', normalized_value: p.volumeMl, raw_value: `${p.volumeMl} ml`,
        source_location: 'demo.platform.size', source_excerpt: `${p.volumeMl} ml`,
        method: 'platform_api', confidence: 0.97, observed_at: now,
      },
      current_price: {
        field: 'current_price', normalized_value: offer.price, raw_value: String(offer.price),
        source_location: 'demo.platform.price', source_excerpt: `${offer.price} Ft`,
        method: 'platform_api', confidence: 0.99, observed_at: now,
      },
    },
    extractionQuality: 0.95,
    extractorKey: 'demo',
    extractorVersion: '1.0.0',
    extractionMethod: 'platform_api',
    parseWarnings: [],
    contentHash: contentHash({ name: offer.name, identity }),
    identityHash: identityHash({ platformProductId: platformId, identity }),
    sourceFingerprint: sourceFingerprint(offer.name, { volume: p.volumeMl }),
  };
}

async function main(): Promise<void> {
  configureLogger({ level: 'warn', pretty: true, service: 'seed-demo' });
  initDb({ connectionString: process.env['DATABASE_URL']!, max: 4 });

  // A demo-adatokhoz aktivaljuk a shopokat, DE a crawl utemezest szandekosan
  // NEM inditjuk el: a next_discovery_at / next_price_refresh_at NULL marad,
  // igy a scheduler nem kezd el valos forrasokat letolteni.
  await execute(`UPDATE shops SET active = true, health_status = 'ok',
                        next_discovery_at = NULL, next_price_refresh_at = NULL`);
  await execute(`UPDATE shops SET health_status = 'degraded' WHERE key = 'italshop'`);
  await execute(`UPDATE shops SET active = false, policy_disabled = true,
                        policy_disabled_reason = 'Jogi ellenorzes folyamatban.'
                  WHERE key = 'veritas'`);

  const shops = await query<{ id: string; key: string }>('SELECT id, key FROM shops');
  const shopId = new Map(shops.map((s) => [s.key, s.id]));
  let platformCounter = 1000;

  for (const p of PRODUCTS) {
    const category = await queryOne<{ id: string; identity_profile: unknown; comparison_policy: unknown }>(
      'SELECT id, identity_profile, comparison_policy FROM product_categories WHERE key = $1',
      [p.category],
    );
    if (!category) continue;

    const producer = await queryOne<{ id: string }>(
      `INSERT INTO producers (canonical_name, status) VALUES ($1,'active')
       ON CONFLICT (name_norm) WHERE status <> 'merged'
       DO UPDATE SET canonical_name = EXCLUDED.canonical_name RETURNING id`,
      [p.producer],
    );
    const family = await queryOne<{ id: string }>(
      `INSERT INTO product_families (category_id, producer_id, canonical_name, product_line, status)
       VALUES ($1,$2,$3,$4,'active') RETURNING id`,
      [category.id, producer!.id, p.family, p.family.toLowerCase()],
    );
    const variant = await queryOne<{ id: string }>(
      `INSERT INTO canonical_variants
         (product_family_id, canonical_display_name, vintage_value, vintage_status,
          age_statement_years, volume_ml, pack_count, packaging_type, edition,
          dosage_style, puttony, abv_percent,
          identity_profile_json, comparison_policy_json, status, origin, approved_at)
       VALUES ($1,$2,$3,$4,$5,$6,1,'standard',$7,$8,$9,$10,$11,$12,'active','manual', now())
       RETURNING id`,
      [
        family!.id, p.display, p.vintage, p.vintageStatus, p.age ?? null, p.volumeMl,
        p.edition ?? null, p.dosage ?? null, p.puttony ?? null, p.abv ?? null,
        JSON.stringify(category.identity_profile), JSON.stringify(category.comparison_policy),
      ],
    );

    if (p.tracked) {
      await execute(
        `INSERT INTO tracked_products (canonical_variant_id, tracking_origin, approved_at)
         VALUES ($1,'manual', now()) ON CONFLICT DO NOTHING`,
        [variant!.id],
      );
    }

    await execute(
      `INSERT INTO variant_shop_status (canonical_variant_id, shop_id, status)
       SELECT $1, id, 'unsearched' FROM shops WHERE active
       ON CONFLICT DO NOTHING`,
      [variant!.id],
    );

    for (const offer of p.offers) {
      const sid = shopId.get(offer.shop);
      if (!sid) continue;
      const crawlRun = await queryOne<{ id: string }>(
        `INSERT INTO crawl_runs
           (shop_id, run_type, trigger, status, adapter_key, adapter_version,
            finished_at, duration_ms, completeness, quality_gate_passed, source_status,
            extract_ok, listings_new)
         VALUES ($1,'discovery','manual','succeeded','demo','1.0.0', now(), 4200,
                 'complete', true, 'ok', 1, 1)
         RETURNING id`,
        [sid],
      );
      await persistListing({
        shopId: sid,
        crawlRunId: crawlRun!.id,
        listing: makeListing(offer, p, producer!.id, `DEMO-${platformCounter++}`),
        comparisonPolicy: { allowedPriceTypes: ['regular', 'sale'], requireInStock: false },
        categoryId: category.id,
      });
    }
  }

  // Parositas minden termekvaltozatra, minden aktiv shopban
  const taxonomy = await getTaxonomy(true);
  const policy = await getMatchPolicy();
  policy.autoMatchEnabled = true;
  policy.autoMatchIdentifierOnly = false;

  const variants = await query<VariantRow>(VARIANT_QUERY);
  const activeShops = await query<{ id: string; key: string }>('SELECT id, key FROM shops WHERE active');
  let matched = 0;
  let review = 0;
  let rejected = 0;

  for (const variant of variants) {
    for (const shop of activeShops) {
      const r = await evaluateVariantForShop({
        variant, shopId: shop.id, shopKey: shop.key,
        taxonomy, policy, sourceHealthy: true,
      });
      if (r.decision.status === 'auto_verified') matched++;
      else if (r.decision.status === 'needs_review' || r.decision.status === 'ambiguous') review++;
      else if (r.decision.status === 'rejected') rejected++;
    }
  }

  const pub = await rebuildAndPublish({ freshnessMaxHours: 240, matcherVersion: '2.1.0' });

  process.stdout.write(
    `\nDemo betoltve:\n` +
    `  termekvaltozat:  ${variants.length}\n` +
    `  igazolt par:     ${matched}\n` +
    `  review eset:     ${review}\n` +
    `  elutasitva:      ${rejected}\n` +
    `  publikalva:      ${pub.published} (${pub.offersTotal} ajanlat, ${pub.shopsIncluded} webshop)\n\n`,
  );

  await closeDb();
}

void main();
