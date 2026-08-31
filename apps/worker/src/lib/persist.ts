/**
 * Listing-, snapshot- es ajanlat-perzisztencia, drift-detektalas es
 * arvaltozas-esemenyek (spec 8.6 - 8.8, 17., 18.3, 18.4).
 *
 * Az idempotencia kulcsa: (crawl_run_id, listing_id) egyediseg a
 * megfigyeleseken - ugyanaz a futas nem duplikal (spec 32.5).
 */
import type { NormalizedSourceListing } from '@radovin/contracts';
import { execute, queryOne, transaction } from '@radovin/db';
import {
  DEFAULT_ANOMALY_CONFIG, detectDrift, detectPriceAnomaly, selectComparablePrice,
  type AnomalyConfig,
} from '@radovin/domain';
import { logger } from '@radovin/observability';
import type { IdentityFields, ComparisonPolicy } from '@radovin/contracts';

export interface PersistResult {
  listingId: string;
  isNew: boolean;
  changed: boolean;
  driftSeverity: 'none' | 'cosmetic' | 'significant' | 'product_changed';
  driftMessage: string | null;
  priceChanged: boolean;
  quarantined: boolean;
  anomalyFlags: string[];
}

export interface PersistOptions {
  shopId: string;
  crawlRunId: string | null;
  listing: NormalizedSourceListing;
  comparisonPolicy: Pick<ComparisonPolicy, 'allowedPriceTypes' | 'requireInStock'>;
  anomalyConfig?: AnomalyConfig;
  /** A kategoria feloldott ID-ja, ha ismert. */
  categoryId?: string | null;
  marketMedianHuf?: number | null;
}

interface ExistingListing {
  id: string;
  identity_hash: string | null;
  raw_name: string;
  producer_id: string | null;
  brand_id: string | null;
  category_id: string | null;
  expression: string | null;
  vintage_value: number | null;
  vintage_status: string;
  age_statement_years: number | null;
  volume_ml: number | null;
  pack_count: number;
  packaging_type: string;
  edition: string | null;
  cask_finish: string | null;
  dosage_style: string | null;
  puttony: number | null;
  abv_percent: number | null;
  gtin: string | null;
  latest_price: number | null;
  latest_availability: string | null;
}

function toIdentityFields(row: ExistingListing, categoryKey: string | null): IdentityFields {
  return {
    categoryKey,
    producer: null, producerId: row.producer_id,
    brand: null, brandId: row.brand_id,
    expression: row.expression,
    vintageValue: row.vintage_value,
    vintageStatus: row.vintage_status as IdentityFields['vintageStatus'],
    ageStatementYears: row.age_statement_years,
    volumeMl: row.volume_ml,
    packCount: row.pack_count,
    packagingType: row.packaging_type as IdentityFields['packagingType'],
    containerType: null,
    edition: row.edition,
    caskFinish: row.cask_finish,
    dosageStyle: row.dosage_style,
    sweetness: null,
    puttony: row.puttony,
    abvPercent: row.abv_percent,
    colour: null, region: null, countryCode: null, grapeVarieties: [],
    gtin: row.gtin, sku: null, flavour: null, fruit: null, aging: null,
    subcategory: null, appellation: null, vineyard: null, organic: null,
  };
}

/**
 * Listing beszurasa vagy frissitese + snapshot + ajanlat + esemenyek.
 * Minden egy tranzakcioban, hogy megszakadt futas ne hagyjon fel-allapotot.
 */
export async function persistListing(opts: PersistOptions): Promise<PersistResult> {
  const { listing, shopId, crawlRunId } = opts;
  const anomalyConfig = opts.anomalyConfig ?? DEFAULT_ANOMALY_CONFIG;

  // Osszehasonlithato ar kivalasztasa (spec 18.2)
  const selection = selectComparablePrice(listing.price, opts.comparisonPolicy);
  listing.price.selectedComparablePriceHuf = selection.selectedPriceHuf;
  listing.price.priceType = selection.priceType;
  listing.price.comparable = selection.comparable;
  listing.price.notComparableReason = selection.notComparableReason;

  return transaction(async (client) => {
    // ── Meglevo listing keresese ──────────────────────────────────────────
    const existingRes = await client.query<ExistingListing>(
      `SELECT sl.id, sl.identity_hash, sl.raw_name, sl.producer_id, sl.brand_id, sl.category_id,
              sl.expression, sl.vintage_value, sl.vintage_status, sl.age_statement_years,
              sl.volume_ml, sl.pack_count, sl.packaging_type, sl.edition, sl.cask_finish,
              sl.dosage_style, sl.puttony, sl.abv_percent, sl.gtin,
              o.selected_comparable_price_huf AS latest_price,
              o.availability_status AS latest_availability
         FROM source_listings sl
         LEFT JOIN offer_observations o ON o.id = sl.latest_offer_id
        WHERE sl.shop_id = $1
          AND ( ($2::text IS NOT NULL AND sl.platform_product_id = $2
                 AND coalesce(sl.platform_variant_id,'') = coalesce($3::text,''))
             OR ($2::text IS NULL AND sl.url_key = $4) )
        LIMIT 1`,
      [shopId, listing.platformProductId ?? null, listing.platformVariantId ?? null, listing.urlKey],
    );
    const existing = existingRes.rows[0] ?? null;
    const isNew = !existing;

    // ── Drift-detektalas (spec 17.2, 17.3) ────────────────────────────────
    let driftSeverity: PersistResult['driftSeverity'] = 'none';
    let driftMessage: string | null = null;
    if (existing) {
      const before = toIdentityFields(existing, listing.identity.categoryKey);
      const drift = detectDrift(before, listing.identity, {
        beforeName: existing.raw_name, afterName: listing.rawName,
      });
      driftSeverity = drift.severity;
      driftMessage = drift.severity === 'none' ? null : drift.message;
    }

    // ── Listing upsert ────────────────────────────────────────────────────
    const listingParams = [
      shopId,
      listing.platformProductId ?? null,
      listing.platformVariantId ?? null,
      listing.sku ?? null,
      listing.gtin ?? null,
      listing.gtin ? listing.gtin.replace(/\D/g, '') : null,
      listing.canonicalUrl,
      listing.urlKey,
      listing.finalUrl ?? listing.canonicalUrl,
      JSON.stringify(listing.redirectChain ?? []),
      listing.rawName,
      listing.rawBrand ?? null,
      listing.rawCategoryPath ?? [],
      listing.imageUrl ?? null,
      listing.identity.producerId ?? null,
      listing.identity.brandId ?? null,
      opts.categoryId ?? null,
      listing.identity.expression ?? null,
      listing.identity.vintageValue ?? null,
      listing.identity.vintageStatus,
      listing.identity.ageStatementYears ?? null,
      listing.identity.volumeMl ?? null,
      listing.identity.packCount,
      listing.identity.packagingType,
      listing.identity.containerType ?? null,
      listing.identity.edition ?? null,
      listing.identity.caskFinish ?? null,
      listing.identity.dosageStyle ?? null,
      listing.identity.sweetness ?? null,
      listing.identity.puttony ?? null,
      listing.identity.abvPercent ?? null,
      listing.identity.colour ?? null,
      listing.identity.region ?? null,
      listing.identity.countryCode ?? null,
      listing.identity.grapeVarieties ?? [],
      JSON.stringify(listing.evidence),
      listing.extractionQuality,
      listing.extractorKey,
      listing.extractorVersion,
      JSON.stringify(listing.parseWarnings),
      listing.sourceFingerprint,
      listing.identityHash,
      listing.contentHash,
      listing.availabilityStatus,
    ];

    let listingId: string;
    if (existing) {
      await client.query(
        `UPDATE source_listings SET
           platform_product_id = coalesce($2, platform_product_id),
           platform_variant_id = coalesce($3, platform_variant_id),
           sku = coalesce($4, sku), gtin = coalesce($5, gtin),
           gtin_normalized = coalesce($6, gtin_normalized),
           canonical_url = $7, url_key = $8, final_url = $9, redirect_chain = $10::jsonb,
           raw_name = $11, raw_brand = $12, raw_category_path = $13, image_url = coalesce($14, image_url),
           producer_id = coalesce($15, producer_id), brand_id = coalesce($16, brand_id),
           category_id = coalesce($17, category_id),
           expression = $18, vintage_value = $19, vintage_status = $20,
           age_statement_years = $21, volume_ml = $22, pack_count = $23,
           packaging_type = $24, container_type = $25, edition = $26, cask_finish = $27,
           dosage_style = $28, sweetness = $29, puttony = $30, abv_percent = $31,
           colour = $32, region = $33, country_code = $34, grape_varieties = $35,
           evidence = $36::jsonb, extraction_quality = $37,
           extractor_key = $38, extractor_version = $39, parse_warnings = $40::jsonb,
           source_fingerprint = $41, identity_hash = $42, content_hash = $43,
           availability_status = $44,
           listing_status = 'active', last_seen_at = now(), last_checked_at = now(),
           last_successful_extract_at = now(), consecutive_failures = 0, missing_since = NULL,
           cluster_status = CASE WHEN $45 = 'product_changed' THEN 'drifted' ELSE cluster_status END
         -- A shop_id feltetel egyszerre vedelem (nem irhatunk at masik webshop
         -- listingjet) es tipusinformacio a $1 parameterhez.
         WHERE id = $46 AND shop_id = $1`,
        [...listingParams, driftSeverity, existing.id],
      );
      listingId = existing.id;
    } else {
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO source_listings
           (shop_id, platform_product_id, platform_variant_id, sku, gtin, gtin_normalized,
            canonical_url, url_key, final_url, redirect_chain, raw_name, raw_brand,
            raw_category_path, image_url, producer_id, brand_id, category_id, expression,
            vintage_value, vintage_status, age_statement_years, volume_ml, pack_count,
            packaging_type, container_type, edition, cask_finish, dosage_style, sweetness,
            puttony, abv_percent, colour, region, country_code, grape_varieties,
            evidence, extraction_quality, extractor_key, extractor_version, parse_warnings,
            source_fingerprint, identity_hash, content_hash, availability_status,
            listing_status, cluster_status, last_checked_at, last_successful_extract_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,$13,$14,$15,$16,$17,$18,
                 $19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34,$35,
                 $36::jsonb,$37,$38,$39,$40::jsonb,$41,$42,$43,$44,
                 'active','unclustered', now(), now())
         RETURNING id`,
        listingParams,
      );
      listingId = inserted.rows[0]!.id;
    }

    // ── Snapshot ──────────────────────────────────────────────────────────
    const snapshot = await client.query<{ id: string }>(
      `INSERT INTO source_listing_snapshots
         (listing_id, crawl_run_id, raw_name, normalized_name, extracted_fields, evidence,
          content_hash, identity_hash, source_fingerprint, extractor_key, extractor_version,
          extraction_method, extraction_quality, parse_warnings, ai_used)
       VALUES ($1,$2,$3,rv_search_norm($3),$4::jsonb,$5::jsonb,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14)
       RETURNING id`,
      [
        listingId, crawlRunId, listing.rawName,
        JSON.stringify(listing.identity), JSON.stringify(listing.evidence),
        listing.contentHash, listing.identityHash, listing.sourceFingerprint,
        listing.extractorKey, listing.extractorVersion, listing.extractionMethod,
        listing.extractionQuality, JSON.stringify(listing.parseWarnings), listing.aiUsed ?? false,
      ],
    );
    const snapshotId = snapshot.rows[0]!.id;
    await client.query('UPDATE source_listings SET latest_snapshot_id = $2 WHERE id = $1', [listingId, snapshotId]);

    // ── Aranomalia (spec 18.4) ────────────────────────────────────────────
    const previousPrice = existing?.latest_price ?? null;
    const anomaly = detectPriceAnomaly(
      listing.price.selectedComparablePriceHuf,
      previousPrice,
      {
        unitPriceHuf: listing.price.unitPriceHuf,
        volumeMl: listing.identity.volumeMl,
        packCount: listing.identity.packCount,
        marketMedianHuf: opts.marketMedianHuf ?? null,
      },
      anomalyConfig,
    );
    const allFlags = [...new Set([...listing.price.anomalyFlags, ...anomaly.flags])];

    // Identitas-drift eseten az ar NEM publikalhato (spec 5.4/3, 17.3)
    const driftBlocks = driftSeverity === 'significant' || driftSeverity === 'product_changed';
    const quarantined = anomaly.quarantine || driftBlocks;
    const observationStatus = driftBlocks
      ? 'identity_drift'
      : listing.price.selectedComparablePriceHuf === null
        ? (listing.price.comparable ? 'extraction_incomplete' : 'invalid_price')
        : listing.availabilityStatus === 'out_of_stock' ? 'out_of_stock' : 'observed';

    // ── Ajanlat-megfigyeles ───────────────────────────────────────────────
    const offer = await client.query<{ id: string }>(
      `INSERT INTO offer_observations
         (listing_id, crawl_run_id, snapshot_id, currency, source_minor_unit, raw_price_value,
          regular_price_huf, sale_price_huf, current_price_huf, member_price_huf,
          coupon_price_huf, quantity_price_huf, unit_price_huf, unit_basis, deposit_amount_huf,
          selected_comparable_price_huf, price_type, comparable, not_comparable_reason,
          vat_included, in_stock, availability_raw, availability_status, valid_from, valid_to,
          observation_status, anomaly_flags, quarantined, quarantine_reason, evidence)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,
               $22,$23,$24,$25,$26,$27,$28,$29,$30::jsonb)
       ON CONFLICT (crawl_run_id, listing_id) WHERE crawl_run_id IS NOT NULL
       DO UPDATE SET observed_at = now(),
                     selected_comparable_price_huf = EXCLUDED.selected_comparable_price_huf,
                     current_price_huf = EXCLUDED.current_price_huf,
                     anomaly_flags = EXCLUDED.anomaly_flags,
                     quarantined = EXCLUDED.quarantined
       RETURNING id`,
      [
        listingId, crawlRunId, snapshotId,
        listing.price.currency, listing.price.sourceMinorUnit, listing.price.rawPriceValue,
        listing.price.regularPriceHuf, listing.price.salePriceHuf, listing.price.currentPriceHuf,
        listing.price.memberPriceHuf, listing.price.couponPriceHuf, listing.price.quantityPriceHuf,
        listing.price.unitPriceHuf, listing.price.unitBasis, listing.price.depositAmountHuf,
        driftBlocks ? null : listing.price.selectedComparablePriceHuf,
        listing.price.priceType,
        driftBlocks ? false : listing.price.comparable,
        driftBlocks ? `Identitas-eltolodas miatt az ar nem publikalhato: ${driftMessage}` : listing.price.notComparableReason,
        listing.price.vatIncluded, listing.price.inStock, listing.price.availabilityRaw,
        listing.availabilityStatus, listing.price.validFrom, listing.price.validTo,
        observationStatus, allFlags, quarantined,
        quarantined ? (driftBlocks ? driftMessage : anomaly.message) : null,
        JSON.stringify(listing.price),
      ],
    );
    const offerId = offer.rows[0]!.id;
    await client.query('UPDATE source_listings SET latest_offer_id = $2 WHERE id = $1', [listingId, offerId]);

    // ── Esemenyek (spec 18.3) ─────────────────────────────────────────────
    const newPrice = driftBlocks ? null : listing.price.selectedComparablePriceHuf;
    let priceChanged = false;

    if (isNew) {
      await client.query(
        `INSERT INTO price_events (listing_id, observation_id, event_type, new_price_huf, new_availability)
         VALUES ($1,$2,'first_seen',$3,$4)`,
        [listingId, offerId, newPrice, listing.availabilityStatus],
      );
    } else {
      if (newPrice !== null && previousPrice !== null && newPrice !== previousPrice) {
        priceChanged = true;
        await client.query(
          `INSERT INTO price_events
             (listing_id, observation_id, event_type, previous_price_huf, new_price_huf,
              delta_huf, delta_pct, significance, detail)
           VALUES ($1,$2,'price_changed',$3,$4,$5,$6,$7,$8::jsonb)`,
          [
            listingId, offerId, previousPrice, newPrice, anomaly.deltaHuf, anomaly.deltaPct,
            anomaly.significance, JSON.stringify({ flags: allFlags, message: anomaly.message }),
          ],
        );
      }
      if (existing.latest_availability && existing.latest_availability !== listing.availabilityStatus) {
        await client.query(
          `INSERT INTO price_events
             (listing_id, observation_id, event_type, previous_availability, new_availability)
           VALUES ($1,$2,'availability_changed',$3,$4)`,
          [listingId, offerId, existing.latest_availability, listing.availabilityStatus],
        );
      }
      if (driftSeverity === 'significant' || driftSeverity === 'product_changed') {
        await client.query(
          `INSERT INTO price_events (listing_id, observation_id, event_type, detail, significance)
           VALUES ($1,$2,'identity_drift',$3::jsonb,'extreme')`,
          [listingId, offerId, JSON.stringify({ severity: driftSeverity, message: driftMessage })],
        );
      }
      if (anomaly.quarantine) {
        await client.query(
          `INSERT INTO price_events (listing_id, observation_id, event_type, detail, significance)
           VALUES ($1,$2,'price_anomaly',$3::jsonb,'extreme')`,
          [listingId, offerId, JSON.stringify({ flags: allFlags, message: anomaly.message })],
        );
      }
    }

    // ── Drift eseten a mar igazolt kapcsolat vedelme (spec 17.3, 17.4) ────
    if (driftBlocks && !isNew) {
      await client.query(
        `UPDATE match_relations
            SET status = 'drifted', drift_detected_at = now(), drift_reason = $2
          WHERE source_listing_id = $1 AND status = 'verified' AND valid_to IS NULL`,
        [listingId, driftMessage],
      );
      await client.query(
        `INSERT INTO review_cases
           (case_type, priority, status, canonical_variant_id, source_listing_id, shop_id,
            match_relation_id, title, reason_codes, context, due_at)
         SELECT 'mapping_drift', 1, 'open', mr.canonical_variant_id, $1, mr.shop_id, mr.id,
                'Identitas-eltolodas: ' || $2, ARRAY['IDENTITY_DRIFT'],
                jsonb_build_object('severity', $3::text, 'message', $2::text),
                now() + interval '24 hours'
           FROM match_relations mr
          WHERE mr.source_listing_id = $1 AND mr.status = 'drifted' AND mr.valid_to IS NULL
         ON CONFLICT DO NOTHING`,
        [listingId, driftMessage ?? 'ismeretlen valtozas', driftSeverity],
      );
    }

    return {
      listingId,
      isNew,
      changed: isNew || existing?.identity_hash !== listing.identityHash || priceChanged,
      driftSeverity,
      driftMessage,
      priceChanged,
      quarantined,
      anomalyFlags: allFlags,
    };
  });
}

/** Egy listing hianyzokent jelolese. NEM torli a kapcsolatot (spec 11.7). */
export async function markListingMissing(listingId: string, reason: string): Promise<void> {
  await execute(
    `UPDATE source_listings
        SET listing_status = 'missing',
            missing_since = coalesce(missing_since, now()),
            consecutive_failures = consecutive_failures + 1,
            last_checked_at = now()
      WHERE id = $1`,
    [listingId],
  );
  await execute(
    `INSERT INTO price_events (listing_id, event_type, detail, significance)
     VALUES ($1,'listing_missing',$2::jsonb,'significant')`,
    [listingId, JSON.stringify({ reason })],
  );
  // A kapcsolat NEM torlodik azonnal - discovery es ujrakereses indul
  await execute(
    `UPDATE variant_shop_status vss
        SET status = 'listing_missing', next_search_at = now() + interval '1 day'
      FROM match_relations mr
      WHERE mr.source_listing_id = $1 AND mr.valid_to IS NULL
        AND vss.canonical_variant_id = mr.canonical_variant_id
        AND vss.shop_id = mr.shop_id`,
    [listingId],
  );
  logger.info('listing.marked_missing', { listingId, reason });
}

/** Kategoria ID feloldasa kulcsbol, cache-elve. */
const categoryIdCache = new Map<string, string | null>();

export async function categoryIdForKey(key: string | null): Promise<string | null> {
  if (!key) return null;
  if (categoryIdCache.has(key)) return categoryIdCache.get(key) ?? null;
  const row = await queryOne<{ id: string }>('SELECT id FROM product_categories WHERE key = $1', [key]);
  categoryIdCache.set(key, row?.id ?? null);
  return row?.id ?? null;
}
