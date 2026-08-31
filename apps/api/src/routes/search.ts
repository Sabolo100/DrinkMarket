/**
 * Globalis termekkereso (spec 22.3).
 *
 * Keres a kanonikus neveken, EREDETI webshopneveken, markan, termelon,
 * evjaraton, kiszerelesen, EAN-on es SKU-n. Egy source listing kivalasztasakor
 * a rendszer automatikusan annak kanonikus valtozatara navigal.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { query } from '@radovin/db';
import { parseVolume, parseVintage, searchNorm } from '@radovin/domain';
import type { AppConfig } from '../config.js';

export async function searchRoutes(app: FastifyInstance, _config: AppConfig): Promise<void> {
  app.get('/search', async (req) => {
    const q = z.object({
      q: z.string().min(1),
      limit: z.coerce.number().int().min(1).max(50).default(12),
      shopId: z.string().uuid().optional(),
    }).parse(req.query);

    const term = q.q.trim();
    const norm = searchNorm(term);
    const digits = term.replace(/\D/g, '');
    const vintage = parseVintage(term, 'name').value;
    const volume = parseVolume(term).unitVolumeMl;

    // Erős azonosito: EAN vagy SKU -> pontos talalat
    const identifierHits = digits.length >= 8
      ? await query(
        `SELECT 'listing' AS kind, sl.id, sl.raw_name AS title, sl.canonical_url AS url,
                sl.image_url, s.name AS shop_name, s.key AS shop_key, s.brand_color,
                mr.canonical_variant_id, 1.0::float AS score, 'EAN egyezes' AS match_reason
           FROM source_listings sl
           JOIN shops s ON s.id = sl.shop_id
           LEFT JOIN match_relations mr ON mr.source_listing_id = sl.id
                 AND mr.status = 'verified' AND mr.valid_to IS NULL
          WHERE sl.gtin_normalized = $1 OR sl.sku = $2
          LIMIT 10`,
        [digits, term],
      )
      : [];

    // Kanonikus termekek
    const variants = await query(
      `SELECT 'variant' AS kind, v.canonical_variant_id AS id,
              v.canonical_display_name AS title, NULL AS url, NULL AS image_url,
              v.category_name, v.brand_name, v.producer_name,
              v.vintage_value, v.volume_ml, v.pack_count,
              v.offer_count, v.shop_count, v.min_price_huf, v.max_price_huf,
              greatest(
                similarity(rv_search_norm(v.canonical_display_name), $1),
                similarity(rv_search_norm(coalesce(v.family_name,'')), $1),
                similarity(rv_search_norm(coalesce(v.brand_name,'')), $1) * 0.8,
                similarity(rv_search_norm(coalesce(v.producer_name,'')), $1) * 0.8
              )::float AS score
         FROM v_market_variants v
        WHERE (
          rv_search_norm(v.canonical_display_name) % $1
          OR v.canonical_display_name ILIKE $2
          OR coalesce(v.brand_name,'') ILIKE $2
          OR coalesce(v.producer_name,'') ILIKE $2
          OR coalesce(v.family_name,'') ILIKE $2
          OR ($3::int IS NOT NULL AND v.vintage_value = $3)
        )
        AND ($4::int IS NULL OR v.volume_ml = $4 OR v.volume_ml IS NULL)
        ORDER BY score DESC, v.offer_count DESC NULLS LAST
        LIMIT $5`,
      [norm, `%${term}%`, vintage, volume, q.limit],
    );

    // Webshop listingek EREDETI nevvel (spec 22.3)
    const listings = await query(
      `SELECT 'listing' AS kind, sl.id, sl.raw_name AS title, sl.canonical_url AS url,
              sl.image_url, sl.vintage_value, sl.volume_ml, sl.cluster_status,
              s.name AS shop_name, s.key AS shop_key, s.brand_color,
              mr.canonical_variant_id,
              o.selected_comparable_price_huf AS price_huf,
              similarity(sl.normalized_name, $1)::float AS score
         FROM source_listings sl
         JOIN shops s ON s.id = sl.shop_id
         LEFT JOIN match_relations mr ON mr.source_listing_id = sl.id
               AND mr.status = 'verified' AND mr.valid_to IS NULL
         LEFT JOIN offer_observations o ON o.id = sl.latest_offer_id
        WHERE sl.listing_status = 'active'
          AND (sl.normalized_name % $1 OR sl.raw_name ILIKE $2)
          AND ($3::uuid IS NULL OR sl.shop_id = $3)
        ORDER BY score DESC, sl.last_seen_at DESC
        LIMIT $4`,
      [norm, `%${term}%`, q.shopId ?? null, q.limit],
    );

    const brands = await query(
      `SELECT 'brand' AS kind, b.id, b.canonical_name AS title,
              similarity(b.name_norm, $1)::float AS score,
              (SELECT count(*)::int FROM product_families pf WHERE pf.brand_id = b.id) AS family_count
         FROM brands b
        WHERE b.status = 'active' AND (b.name_norm % $1 OR b.canonical_name ILIKE $2)
        ORDER BY score DESC LIMIT 6`,
      [norm, `%${term}%`],
    );

    const producers = await query(
      `SELECT 'producer' AS kind, p.id, p.canonical_name AS title,
              similarity(p.name_norm, $1)::float AS score,
              (SELECT count(*)::int FROM product_families pf WHERE pf.producer_id = p.id) AS family_count
         FROM producers p
        WHERE p.status = 'active' AND (p.name_norm % $1 OR p.canonical_name ILIKE $2)
        ORDER BY score DESC LIMIT 6`,
      [norm, `%${term}%`],
    );

    return {
      query: term,
      parsed: { vintage, volumeMl: volume, digits: digits.length >= 8 ? digits : null },
      identifierHits,
      variants,
      listings,
      brands,
      producers,
      total: identifierHits.length + variants.length + listings.length,
    };
  });

  /**
   * Egy source listing "feloldasa": ha mar klaszterezve van, a kanonikus
   * valtozat ID-jat adja vissza, hogy a UI oda navigalhasson (spec 22.3).
   */
  app.get('/search/resolve-listing/:id', async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const rows = await query<{
      canonical_variant_id: string | null; cluster_status: string; raw_name: string;
      shop_name: string; open_review_id: string | null;
    }>(
      `SELECT mr.canonical_variant_id, sl.cluster_status, sl.raw_name, s.name AS shop_name,
              (SELECT rc.id FROM review_cases rc
                WHERE rc.source_listing_id = sl.id AND rc.status IN ('open','in_progress')
                ORDER BY rc.created_at DESC LIMIT 1) AS open_review_id
         FROM source_listings sl
         JOIN shops s ON s.id = sl.shop_id
         LEFT JOIN match_relations mr ON mr.source_listing_id = sl.id
               AND mr.status = 'verified' AND mr.valid_to IS NULL
        WHERE sl.id = $1`,
      [id],
    );
    const row = rows[0];
    if (!row) return { found: false };
    return {
      found: true,
      canonicalVariantId: row.canonical_variant_id,
      clusterStatus: row.cluster_status,
      listingName: row.raw_name,
      shopName: row.shop_name,
      openReviewId: row.open_review_id,
      navigateTo: row.canonical_variant_id
        ? `/termek/${row.canonical_variant_id}`
        : row.open_review_id
          ? `/parositas/${row.open_review_id}`
          : `/terméktár/listing/${id}`,
    };
  });
}
