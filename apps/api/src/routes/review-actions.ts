/**
 * A parositasi dontesek MAGJA - egyetlen helyen.
 *
 * Ket hivo van: az egyeses vegpontok (`review.ts`) es a kotegelt
 * (`review-batch.ts`). Ha a ketto kulon elne, elobb-utobb szetcsusznanak, es
 * a felulet ket kulonbozo dolgot csinalna ugyanarra a gombra - ami a
 * legrosszabb fajta hiba, mert sokaig lathatatlan marad.
 */
import type { PoolClient } from 'pg';
import { queryOne } from '@radovin/db';
import { AppError } from '@radovin/observability';

export interface DecisionOpts {
  caseId: string;
  canonicalVariantId: string;
  listingId: string;
  actorId: string;
  note: string | null;
  confidence: number | null;
}

export interface RejectOpts extends DecisionOpts {
  shopId: string | null;
  reasonCode: string;
}

export interface OpenCase {
  id: string;
  canonical_variant_id: string | null;
  source_listing_id: string | null;
  shop_id: string | null;
  confidence: number | null;
  candidates: unknown;
  row_version: number;
}

export async function loadOpenCase(id: string, expectedVersion?: number): Promise<OpenCase> {
  const rc = await queryOne<OpenCase & { status: string }>(
    `SELECT id, canonical_variant_id, source_listing_id, shop_id, confidence,
            candidates, row_version, status
       FROM review_cases WHERE id = $1`,
    [id],
  );
  if (!rc) throw new AppError('NOT_FOUND', 'A felulvizsgalati eset nem talalhato.', 404);
  if (rc.status === 'resolved' || rc.status === 'dismissed') {
    throw new AppError('CASE_CLOSED', 'Ez az eset mar lezarult.', 409);
  }
  if (expectedVersion !== undefined && rc.row_version !== expectedVersion) {
    throw new AppError(
      'VERSION_CONFLICT',
      `Az esetet idokozben modositottak (varhato: ${expectedVersion}, aktualis: ${rc.row_version}). Toltsd ujra.`,
      409, { currentVersion: rc.row_version },
    );
  }
  return rc;
}

export async function closeCase(
  client: { query: (sql: string, params: unknown[]) => Promise<unknown> },
  id: string,
  actorId: string,
  resolution: string,
  note: string | null,
): Promise<void> {
  await client.query(
    `UPDATE review_cases
        SET status = 'resolved', resolution = $3, resolution_note = $4,
            resolved_by = $2, resolved_at = now(), row_version = row_version + 1
      WHERE id = $1`,
    [id, actorId, resolution, note],
  );
  await client.query(
    `INSERT INTO review_case_events (review_case_id, actor_user_id, action, note)
     VALUES ($1,$2,$3,$4)`,
    [id, actorId, resolution, note],
  );
}


/**
 * A jovahagyas magja. Egyetlen helyen, mert ket hivo van: az egyeses vegpont
 * es a kotegelt. Ha a ketto kulon elne, elobb-utobb szetcsusznanak, es a
 * felulet ket kulonbozo dolgot csinalna ugyanarra a gombra.
 */
export async function applyApprove(client: PoolClient, opts: DecisionOpts): Promise<void> {
  // Egy listingnek legfeljebb egy aktiv verified kapcsolata lehet (spec 8.9)
  await client.query(
    `UPDATE match_relations SET valid_to = now(), status = 'suspended'
      WHERE source_listing_id = $1 AND status = 'verified' AND valid_to IS NULL
        AND canonical_variant_id <> $2`,
    [opts.listingId, opts.canonicalVariantId],
  );
  await client.query(
    `INSERT INTO match_relations
       (canonical_variant_id, source_listing_id, shop_id, status, decision_origin,
        verified_kind, locked_by_human, last_verified_at, identity_hash_at_decision, confidence)
     SELECT $1, $2, sl.shop_id, 'verified', 'human', 'human_verified', true, now(),
            sl.identity_hash, $3
       FROM source_listings sl WHERE sl.id = $2
     ON CONFLICT (canonical_variant_id, source_listing_id) WHERE valid_to IS NULL
     DO UPDATE SET status = 'verified', decision_origin = 'human',
                   verified_kind = 'human_verified', locked_by_human = true,
                   last_verified_at = now(), drift_detected_at = NULL, drift_reason = NULL,
                   version = match_relations.version + 1`,
    [opts.canonicalVariantId, opts.listingId, opts.confidence],
  );
  await client.query(
    `INSERT INTO match_decisions
       (canonical_variant_id, source_listing_id, shop_id, status, matcher_version,
        taxonomy_version, policy_version, decided_by, reviewer_user_id, reviewed_at,
        review_note, reason_codes, match_relation_id)
     SELECT $1, $2, sl.shop_id, 'human_verified', 'human', 'human', 'human',
            'human', $3, now(), $4, ARRAY['MANUAL_APPROVAL'],
            (SELECT id FROM match_relations WHERE canonical_variant_id = $1
               AND source_listing_id = $2 AND valid_to IS NULL)
       FROM source_listings sl WHERE sl.id = $2`,
    [opts.canonicalVariantId, opts.listingId, opts.actorId, opts.note],
  );
  await client.query(
    `UPDATE source_listings SET cluster_status = 'clustered' WHERE id = $1`, [opts.listingId],
  );
  await client.query(
    `INSERT INTO variant_shop_status
       (canonical_variant_id, shop_id, status, matched_listing_id, last_search_at)
     SELECT $1, sl.shop_id, 'human_verified', $2, now() FROM source_listings sl WHERE sl.id = $2
     ON CONFLICT (canonical_variant_id, shop_id)
     DO UPDATE SET status = 'human_verified', matched_listing_id = $2,
                   consecutive_no_match = 0, primary_reason_code = NULL, reason_codes = '{}'`,
    [opts.canonicalVariantId, opts.listingId],
  );
  await closeCase(client, opts.caseId, opts.actorId, 'approved', opts.note);
}

/**
 * Az elutasitas magja.
 *
 * Harom dolog tortenik, es a harmadik a legfontosabb: a `variant_shop_status`
 * frissitese. Enelkul a sor NEM fogy - az `unmatched-research` a
 * `next_search_at` szerint ujra elovenne ugyanezt a part, es az ember ujra
 * dontene rola. A 30 napos halasztas nem orokre szol: egy uj listing vagy egy
 * javitott kinyeres kesobb hozhat jobb jeloltet.
 */
export async function applyReject(client: PoolClient, opts: RejectOpts): Promise<void> {
  await client.query(
    `UPDATE match_relations SET status = 'rejected', valid_to = now()
      WHERE canonical_variant_id = $1 AND source_listing_id = $2 AND valid_to IS NULL`,
    [opts.canonicalVariantId, opts.listingId],
  );
  // Negativ memoria: azonos fingerprint mellett nem ajanljuk fel ujra (spec 14.3)
  await client.query(
    `INSERT INTO rejected_candidates
       (canonical_variant_id, source_listing_id, shop_id, rejected_by, reviewer_user_id,
        reason_code, reason_note, listing_identity_hash, variant_identity_hash, score_at_rejection)
     SELECT $1, $2, sl.shop_id, 'human', $3, $4, $5,
            coalesce(sl.identity_hash, ''), coalesce(cv.identity_hash, ''), $6
       FROM source_listings sl, canonical_variants cv
      WHERE sl.id = $2 AND cv.id = $1
     ON CONFLICT DO NOTHING`,
    [opts.canonicalVariantId, opts.listingId, opts.actorId, opts.reasonCode, opts.note, opts.confidence],
  );
  if (opts.shopId) {
    await client.query(
      `INSERT INTO variant_shop_status
         (canonical_variant_id, shop_id, status, primary_reason_code,
          last_search_at, next_search_at, consecutive_no_match)
       VALUES ($1, $2, 'rejected', $3, now(), now() + interval '30 days', 0)
       ON CONFLICT (canonical_variant_id, shop_id) DO UPDATE SET
         status = 'rejected',
         primary_reason_code = EXCLUDED.primary_reason_code,
         matched_listing_id = NULL,
         last_search_at = now(),
         next_search_at = EXCLUDED.next_search_at`,
      [opts.canonicalVariantId, opts.shopId, opts.reasonCode],
    );
  }
  await closeCase(client, opts.caseId, opts.actorId, 'rejected', opts.note);
}

/**
 * A piaci publikacio ujraepitesenek kerese egy EMBERI dontes utan.
 *
 * Enelkul a jovahagyas nem latszik: az ar-osszehasonlitas a
 * `market_publications` tablabol olvas, azt pedig csak a scheduler epiti
 * ujra - orankent egyszer (`>55 perc`). Aki jovahagy egy parositast es
 * rogton megnezi a fooldalt, semmit nem lat, es joggal hiszi, hogy nem
 * mukodik.
 *
 * A rovid kesleltetes es a kozos kulcs szandekos: aki egymas utan hagy jova
 * tizet - vagy a kotegelt felulettel egyszerre otot -, annak EGY ujraepites
 * fusson, ne tiz.
 */
export async function requestPublicationRebuild(
  enqueueFn: (opts: {
    queue: 'aggregate-dashboard'; name: string; payload: Record<string, unknown>;
    idempotencyKey: string; delayMs?: number; correlationId?: string;
  }) => Promise<unknown>,
  trigger: string,
  correlationId?: string,
): Promise<void> {
  // Sajat kulcs, a schedulereetol FUGGETLENUL: ha az orankenti ujraepites
  // eppen fut, a kozos kulcs miatt a mi keresunk deduplikalodna ra - es a
  // most hozott dontes kimaradna a mar futo publikaciobol.
  //
  // A 30 masodperces idoveder osszevonja a gyors egymasutani donteseket
  // (egy kotegelt mentes, vagy tiz kattintas), de nem tapad egy mar futo
  // jobra.
  const bucket = Math.floor(Date.now() / 30_000);
  await enqueueFn({
    queue: 'aggregate-dashboard', name: 'rebuild',
    payload: { trigger },
    idempotencyKey: `aggregate:rebuild:human:${bucket}`,
    delayMs: 15_000,
    correlationId,
  }).catch(() => undefined);
}
