/**
 * Arfrissites es karbantartas (spec 5.4, 11.7, 18.1, 19.).
 *
 * Igazolt paroknal ELSOKENT a mar ismert listing platformazonositojat vagy
 * kozvetlen linkjet ellenorizzuk, es UJRA KINYERJUK az identitas lenyeges
 * mezoit is - nem csak az arat.
 */
import type { Job } from 'bullmq';
import type { KnownListingRef } from '@radovin/contracts';
import { buildAdapterContext, getAdapter } from '@radovin/adapters';
import { loadRobots } from '@radovin/crawler-core';
import { execute, query, queryOne } from '@radovin/db';
import { logger, metrics, newCorrelationId, withContext } from '@radovin/observability';
import type { WorkerConfig } from '../config.js';
import { categoryIdForKey, markListingMissing, persistListing } from '../lib/persist.js';
import { cleanupArtifacts } from '../lib/artifacts.js';
import { raiseAlert, rebuildAndPublish } from '../lib/publish.js';
import { getSettings, getTaxonomy, loadShop, resolversFor } from '../lib/shop.js';
import { enqueueFromWorker } from '../lib/queue-client.js';

export interface RefreshShopPayload {
  shopId: string;
  limit?: number;
  trigger?: string;
  correlationId?: string;
}

export async function processRefreshShop(job: Job<RefreshShopPayload>, config: WorkerConfig): Promise<unknown> {
  const correlationId = job.data.correlationId ?? newCorrelationId();
  const { shopId } = job.data;

  return withContext({ correlationId, shopId }, async () => {
    const shop = await loadShop(shopId);
    if (!shop) throw new Error(`Ismeretlen webshop: ${shopId}`);
    if (shop.policyDisabled) return { skipped: true, reason: 'policy_disabled' };

    const settings = await getSettings();
    const pricing = (settings.settings.get('pricing.comparison') ?? {}) as { allowedPriceTypes?: string[] };
    const anomalyCfg = settings.settings.get('pricing.anomaly') as never;
    const limit = job.data.limit ?? 2000;

    // Igazolt kapcsolatu listingek + a korabban eltuntek heti ujraellenorzese
    const listings = await query<KnownListingRef & { identity_hash: string | null }>(
      `SELECT sl.id, sl.canonical_url, sl.final_url, sl.platform_product_id AS "platformProductId",
              sl.platform_variant_id AS "platformVariantId", sl.sku, sl.url_key AS "urlKey",
              sl.identity_hash
         FROM source_listings sl
        WHERE sl.shop_id = $1
          AND sl.listing_status IN ('active','missing')
          AND (
            EXISTS (SELECT 1 FROM match_relations mr
                     WHERE mr.source_listing_id = sl.id
                       AND mr.status IN ('verified','drifted') AND mr.valid_to IS NULL)
            OR sl.listing_status = 'missing'
          )
          AND (sl.last_checked_at IS NULL
               OR sl.last_checked_at < now() - interval '6 hours')
        ORDER BY sl.last_checked_at ASC NULLS FIRST
        LIMIT $2`,
      [shopId, limit],
    );

    if (!listings.length) return { refreshed: 0, reason: 'nothing_due' };

    const run = await queryOne<{ id: string }>(
      `INSERT INTO crawl_runs (shop_id, run_type, trigger, status, adapter_key, adapter_version, correlation_id)
       VALUES ($1,'price_refresh',$2,'running',$3,$4,$5) RETURNING id`,
      [shopId, job.data.trigger ?? 'scheduler', shop.adapterKey, shop.adapterVersion, correlationId],
    );
    const runId = run!.id;
    const started = Date.now();

    const taxonomy = await getTaxonomy();
    const adapter = getAdapter(shop.adapterKey);
    const robots = shop.crawlPolicy.respectRobots
      ? await loadRobots(shop.baseUrl, shop.crawlPolicy.userAgent ?? config.userAgent)
      : null;

    const built = await buildAdapterContext({
      shop, runId, correlationId,
      userAgent: config.userAgent,
      ...(config.contactEmail ? { contactEmail: config.contactEmail } : {}),
      allowBrowser: config.mode !== 'http',
      robots,
      resolvers: resolversFor(taxonomy),
      limits: { maxUrls: listings.length, maxDurationMs: config.maxRunDurationMs, maxPages: listings.length + 50 },
    });

    let ok = 0; let failed = 0; let missing = 0; let drifted = 0; let priceChanges = 0;
    const concurrency = Math.max(1, shop.crawlPolicy.maxConcurrency);
    let index = 0;

    const loop = async (): Promise<void> => {
      for (;;) {
        const i = index++;
        if (i >= listings.length) return;
        if (Date.now() - started > config.maxRunDurationMs) return;
        const listing = listings[i]!;
        try {
          const result = await adapter.refreshKnownListing(built.ctx, listing);

          if (result.status === 'unavailable') {
            // 404 eseten NEM torlodik a kapcsolat: eltuntkent jeloljuk,
            // es a discovery / ujrakereses dont a sorsarol (spec 11.7).
            await markListingMissing(listing.id, 'Az arfrissiteskor a termekoldal nem elerheto (404/eltunt).');
            missing++;
            continue;
          }
          if (result.status !== 'ok' || !result.listing) {
            failed++;
            await execute(
              `UPDATE source_listings
                  SET last_checked_at = now(), consecutive_failures = consecutive_failures + 1
                WHERE id = $1`,
              [listing.id],
            );
            continue;
          }

          const categoryId = await categoryIdForKey(result.listing.identity.categoryKey);
          const persisted = await persistListing({
            shopId, crawlRunId: runId, listing: result.listing,
            comparisonPolicy: {
              allowedPriceTypes: (pricing.allowedPriceTypes ?? ['regular', 'sale']) as never,
              requireInStock: false,
            },
            anomalyConfig: anomalyCfg,
            categoryId,
          });
          ok++;
          if (persisted.priceChanged) priceChanges++;
          if (persisted.driftSeverity === 'significant' || persisted.driftSeverity === 'product_changed') {
            drifted++;
          }
        } catch (err) {
          failed++;
          logger.warn('refresh.listing_failed', {
            listingId: listing.id,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    };

    await Promise.all(Array.from({ length: concurrency }, () => loop()));

    const successRate = listings.length ? ok / listings.length : 1;
    const status = successRate >= 0.7 ? 'succeeded' : successRate >= 0.3 ? 'partial' : 'failed';

    await execute(
      `UPDATE crawl_runs SET
         status = $2, source_status = $3, finished_at = now(), duration_ms = $4,
         requests_attempted = $5, requests_succeeded = $6, requests_failed = $7,
         rate_limit_hits = $8, extract_ok = $9, extract_failed = $10,
         listings_missing = $11, listings_updated = $12,
         http_status_counts = $13::jsonb, quality_gate_passed = $14
       WHERE id = $1`,
      [
        runId, status, status === 'succeeded' ? 'ok' : status === 'partial' ? 'partial' : 'unavailable',
        Date.now() - started,
        built.diagnostics.requestsAttempted, built.diagnostics.requestsSucceeded,
        built.diagnostics.requestsFailed, built.diagnostics.rateLimitHits,
        ok, failed, missing, priceChanges,
        JSON.stringify(built.diagnostics.httpStatusCounts),
        status === 'succeeded',
      ],
    );

    await execute(
      `UPDATE shops SET last_price_refresh_at = now(),
              next_price_refresh_at = now() + (price_refresh_interval_hours || ' hours')::interval
        WHERE id = $1`,
      [shopId],
    );

    if (drifted > 0) {
      await raiseAlert({
        key: `drift:${shop.key}`,
        level: drifted > 20 ? 'error' : 'warn',
        category: 'matching', shopId,
        title: `${drifted} identitas-eltolodas a ${shop.name} forrasnal`,
        message: `Az arfrissites soran ${drifted} korabban igazolt kapcsolat identitasa megvaltozott. Az erintett arak nem publikalodnak.`,
        detail: { runId, drifted },
      });
    }

    metrics.counter('refresh.ok', ok, { shop: shop.key });
    metrics.counter('refresh.failed', failed, { shop: shop.key });
    metrics.counter('refresh.price_changes', priceChanges, { shop: shop.key });

    await enqueueFromWorker(config, {
      queue: 'aggregate-dashboard', name: 'rebuild',
      payload: { trigger: 'price_refresh' }, idempotencyKey: 'aggregate:rebuild',
      delayMs: 30_000, correlationId,
    });

    return { runId, checked: listings.length, ok, failed, missing, drifted, priceChanges, status };
  });
}

export interface RefreshListingPayload {
  sourceListingId: string;
  trigger?: string;
  correlationId?: string;
}

export async function processRefreshListing(job: Job<RefreshListingPayload>, config: WorkerConfig): Promise<unknown> {
  const correlationId = job.data.correlationId ?? newCorrelationId();
  const { sourceListingId } = job.data;

  return withContext({ correlationId, listingId: sourceListingId }, async () => {
    const listing = await queryOne<KnownListingRef & { shop_id: string }>(
      `SELECT id, shop_id, canonical_url AS "canonicalUrl", final_url AS "finalUrl",
              platform_product_id AS "platformProductId", platform_variant_id AS "platformVariantId",
              sku, url_key AS "urlKey"
         FROM source_listings WHERE id = $1`,
      [sourceListingId],
    );
    if (!listing) return { skipped: true, reason: 'listing_not_found' };

    const shop = await loadShop(listing.shop_id);
    if (!shop || shop.policyDisabled) return { skipped: true, reason: 'shop_unavailable' };

    const settings = await getSettings();
    const pricing = (settings.settings.get('pricing.comparison') ?? {}) as { allowedPriceTypes?: string[] };
    const taxonomy = await getTaxonomy();
    const adapter = getAdapter(shop.adapterKey);

    const run = await queryOne<{ id: string }>(
      `INSERT INTO crawl_runs (shop_id, run_type, trigger, status, adapter_key, adapter_version, correlation_id)
       VALUES ($1,'price_refresh',$2,'running',$3,$4,$5) RETURNING id`,
      [listing.shop_id, job.data.trigger ?? 'review', shop.adapterKey, shop.adapterVersion, correlationId],
    );
    const runId = run!.id;

    const built = await buildAdapterContext({
      shop, runId, correlationId,
      userAgent: config.userAgent,
      ...(config.contactEmail ? { contactEmail: config.contactEmail } : {}),
      allowBrowser: config.mode !== 'http',
      resolvers: resolversFor(taxonomy),
      limits: { maxUrls: 3, maxDurationMs: 90_000, maxPages: 3 },
    });

    const result = await adapter.refreshKnownListing(built.ctx, listing);

    if (result.status === 'unavailable') {
      await markListingMissing(sourceListingId, 'Az ellenorzeskor a termekoldal nem elerheto.');
      await execute(
        `UPDATE crawl_runs SET status = 'succeeded', finished_at = now(), listings_missing = 1 WHERE id = $1`,
        [runId],
      );
      return { ok: false, status: 'missing' };
    }
    if (result.status !== 'ok' || !result.listing) {
      await execute(
        `UPDATE crawl_runs SET status = 'failed', finished_at = now(), extract_failed = 1 WHERE id = $1`,
        [runId],
      );
      return { ok: false, status: result.status };
    }

    const categoryId = await categoryIdForKey(result.listing.identity.categoryKey);
    const persisted = await persistListing({
      shopId: listing.shop_id, crawlRunId: runId, listing: result.listing,
      comparisonPolicy: {
        allowedPriceTypes: (pricing.allowedPriceTypes ?? ['regular', 'sale']) as never,
        requireInStock: false,
      },
      categoryId,
    });

    await execute(
      `UPDATE crawl_runs SET status = 'succeeded', finished_at = now(), extract_ok = 1 WHERE id = $1`,
      [runId],
    );

    await enqueueFromWorker(config, {
      queue: 'aggregate-dashboard', name: 'rebuild',
      payload: { trigger: 'listing_refresh' }, idempotencyKey: 'aggregate:rebuild',
      delayMs: 30_000, correlationId,
    });

    return {
      ok: true, listingId: persisted.listingId,
      priceChanged: persisted.priceChanged,
      driftSeverity: persisted.driftSeverity,
      price: result.listing.price.selectedComparablePriceHuf,
    };
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// Aggregatum ujraepitese es publikalasa
// ═══════════════════════════════════════════════════════════════════════════

export async function processAggregate(
  job: Job<{ trigger?: string; correlationId?: string }>,
  _config: WorkerConfig,
): Promise<unknown> {
  const correlationId = job.data.correlationId ?? newCorrelationId();
  return withContext({ correlationId }, async () => {
    const settings = await getSettings();
    const pricing = (settings.settings.get('pricing.comparison') ?? {}) as { freshnessMaxHours?: number };
    const matcherVersion = String(settings.settings.get('matcher.version') ?? '2.1.0').replace(/"/g, '');
    const autoPublish = settings.flags.get('auto_publish') ?? true;

    const result = await rebuildAndPublish({
      freshnessMaxHours: pricing.freshnessMaxHours ?? 240,
      matcherVersion,
      correlationId,
      dryRun: !autoPublish,
    });
    return result;
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// Karbantartas: retencio, elhalasztott review-k, halott sorok
// ═══════════════════════════════════════════════════════════════════════════

export async function processRetentionCleanup(
  job: Job<{ correlationId?: string }>,
  config: WorkerConfig,
): Promise<unknown> {
  const correlationId = job.data.correlationId ?? newCorrelationId();
  return withContext({ correlationId }, async () => {
    const settings = await getSettings();
    const retention = (settings.settings.get('retention') ?? {}) as {
      rawArtifactDays?: number; snapshotDays?: number;
      observationDays?: number; metricDays?: number;
    };

    const artifactsRemoved = await cleanupArtifacts(config);

    const snapshots = await execute(
      `DELETE FROM source_listing_snapshots
        WHERE observed_at < now() - ($1 || ' days')::interval
          AND id NOT IN (SELECT latest_snapshot_id FROM source_listings WHERE latest_snapshot_id IS NOT NULL)`,
      [String(retention.snapshotDays ?? 400)],
    );

    const observations = await execute(
      `DELETE FROM offer_observations
        WHERE observed_at < now() - ($1 || ' days')::interval
          AND id NOT IN (SELECT latest_offer_id FROM source_listings WHERE latest_offer_id IS NOT NULL)`,
      [String(retention.observationDays ?? 1100)],
    );

    const metricRows = await execute(
      `DELETE FROM metric_samples WHERE recorded_at < now() - ($1 || ' days')::interval`,
      [String(retention.metricDays ?? 180)],
    );

    const sessions = await execute(`DELETE FROM sessions WHERE expires_at < now() - interval '7 days'`);

    // Elhalasztott review esetek visszanyitasa
    const reopened = await execute(
      `UPDATE review_cases SET status = 'open', deferred_until = NULL
        WHERE status = 'deferred' AND deferred_until IS NOT NULL AND deferred_until <= now()`,
    );

    // Regi job_runs rekordok
    const jobs = await execute(
      `DELETE FROM job_runs WHERE queued_at < now() - interval '30 days' AND status IN ('succeeded','cancelled')`,
    );

    logger.info('retention.cleanup', {
      artifactsRemoved, snapshots, observations, metricRows, sessions, reopened, jobs,
    });

    return { artifactsRemoved, snapshots, observations, metricRows, sessions, reopenedReviews: reopened, jobs };
  });
}

/** Riasztasok kikuldese webhookra (spec 30.3). */
export async function processAlertDispatch(
  job: Job<{ webhookUrl?: string; minLevel?: string; correlationId?: string }>,
  _config: WorkerConfig,
): Promise<unknown> {
  const webhookUrl = job.data.webhookUrl ?? process.env['ALERT_WEBHOOK_URL'];
  const minLevel = job.data.minLevel ?? process.env['ALERT_MIN_LEVEL'] ?? 'warn';
  const levels = ['info', 'warn', 'error', 'critical'];
  const threshold = levels.indexOf(minLevel);

  const pending = await query<{
    id: string; level: string; category: string; title: string; message: string;
    occurrence_count: number; shop_name: string | null;
  }>(
    `SELECT a.id, a.level, a.category, a.title, a.message, a.occurrence_count, s.name AS shop_name
       FROM alerts a LEFT JOIN shops s ON s.id = a.shop_id
      WHERE a.resolved_at IS NULL AND a.dispatched_at IS NULL
      ORDER BY a.last_seen_at DESC LIMIT 50`,
  );

  const toSend = pending.filter((a) => levels.indexOf(a.level) >= threshold);
  if (!toSend.length) return { dispatched: 0 };

  if (!webhookUrl) {
    // Nincs webhook: csak megjeloljuk, hogy a UI-ban lathato legyen
    await execute(
      `UPDATE alerts SET dispatched_at = now() WHERE id = ANY($1::uuid[])`,
      [toSend.map((a) => a.id)],
    );
    return { dispatched: 0, reason: 'no_webhook_configured', markedSeen: toSend.length };
  }

  // Aggregalt, cselekvesre alkalmas uzenet (spec 30.3)
  const body = {
    source: 'radovin-price-intelligence',
    generatedAt: new Date().toISOString(),
    alertCount: toSend.length,
    alerts: toSend.map((a) => ({
      level: a.level, category: a.category, title: a.title,
      message: a.message, occurrences: a.occurrence_count, shop: a.shop_name,
    })),
  };

  try {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    if (res.ok) {
      await execute(`UPDATE alerts SET dispatched_at = now() WHERE id = ANY($1::uuid[])`, [toSend.map((a) => a.id)]);
      return { dispatched: toSend.length };
    }
    logger.warn('alert.dispatch_failed', { status: res.status });
    return { dispatched: 0, httpStatus: res.status };
  } catch (err) {
    logger.warn('alert.dispatch_error', { error: err instanceof Error ? err.message : String(err) });
    return { dispatched: 0, error: true };
  }
}
