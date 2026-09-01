/**
 * Discovery es termekkinyeres processzorok (spec 5.2, 11.6, 19.4).
 *
 * Shop-first feldolgozas: a teljes katalogus egyszeri letoltese, minden listing
 * normalizalasa, valtozasok DB-be irasa, majd az UJ es MODOSULT listingek
 * parositasa - NEM termekenkent inditott kereses.
 */
import type { Job } from 'bullmq';
import type { AdapterContext, DiscoveredTarget, SourceStatus } from '@radovin/contracts';
import { buildAdapterContext, getAdapter } from '@radovin/adapters';
import { loadRobots } from '@radovin/crawler-core';
import { execute, query, queryOne } from '@radovin/db';
import { logger, metrics, newCorrelationId, withContext } from '@radovin/observability';
import type { WorkerConfig } from '../config.js';
import { categoryIdForKey, markListingMissing, persistListing } from '../lib/persist.js';
import { rotateTargets } from '../lib/discovery-cursor.js';

/** Milyen surun adjon eletjelet a futo felderites. */
const HEARTBEAT_INTERVAL_MS = 30_000;
import { loadKnownListings } from '../lib/known-listings.js';
import { raiseAlert, runShopQualityGate } from '../lib/publish.js';
import { getSettings, getTaxonomy, loadShop, resolversFor } from '../lib/shop.js';
import { saveArtifact } from '../lib/artifacts.js';
import { enqueueFromWorker } from '../lib/queue-client.js';

export interface DiscoveryPayload {
  shopId: string;
  trigger?: string;
  actorUserId?: string;
  correlationId?: string;
}

export async function processDiscovery(job: Job<DiscoveryPayload>, config: WorkerConfig): Promise<unknown> {
  const { shopId } = job.data;
  const correlationId = job.data.correlationId ?? newCorrelationId();

  return withContext({ correlationId, shopId, jobId: String(job.id) }, async () => {
    const shop = await loadShop(shopId);
    if (!shop) throw new Error(`Ismeretlen webshop: ${shopId}`);
    if (shop.policyDisabled) {
      logger.warn('discovery.policy_disabled', { shopKey: shop.key });
      return { skipped: true, reason: 'policy_disabled' };
    }

    const settings = await getSettings();
    const gateConfig = (settings.settings.get('quality_gate.shop') ?? {}) as {
      maxCatalogDropPct?: number; minParserSuccessRate?: number;
    };
    const pricing = (settings.settings.get('pricing.comparison') ?? {}) as {
      allowedPriceTypes?: string[]; includeOutOfStockInRank?: boolean;
    };
    const anomalyCfg = settings.settings.get('pricing.anomaly') as never;

    const catalogBefore = await queryOne<{ count: number }>(
      `SELECT count(*)::int AS count FROM source_listings
        WHERE shop_id = $1 AND listing_status = 'active'`,
      [shopId],
    );

    // ── Futas rekord ─────────────────────────────────────────────────────
    const run = await queryOne<{ id: string }>(
      `INSERT INTO crawl_runs
         (shop_id, run_type, trigger, triggered_by, status, adapter_key, adapter_version,
          config_snapshot, catalog_size_before, correlation_id)
       VALUES ($1,'discovery',$2,$3,'running',$4,$5,$6::jsonb,$7,$8)
       RETURNING id`,
      [
        shopId, job.data.trigger ?? 'scheduler', job.data.actorUserId ?? null,
        shop.adapterKey, shop.adapterVersion,
        JSON.stringify({ policy: shop.crawlPolicy, adapterConfig: shop.adapterConfig }),
        catalogBefore?.count ?? 0, correlationId,
      ],
    );
    const runId = run!.id;
    const started = Date.now();

    await execute('UPDATE shops SET last_discovery_run_id = $2 WHERE id = $1', [shopId, runId]);

    // Hol hagytuk abba, es mikor kezdodott a jelenlegi teljes kor.
    const resumeState = (await queryOne<{ resumeUrl: string | null; cycleStartedAt: Date | null }>(
      `SELECT discovery_resume_url AS "resumeUrl",
              discovery_cycle_started_at AS "cycleStartedAt"
         FROM shops WHERE id = $1`,
      [shopId],
    )) ?? { resumeUrl: null, cycleStartedAt: null };
    // Az elso futasnal meg nincs kor - a futas kezdete a kor kezdete is.
    const cycleStartedAt = resumeState.cycleStartedAt ?? new Date(started);

    let status: SourceStatus = 'ok';
    let newCount = 0; let updatedCount = 0; let unchangedCount = 0;
    let extractOk = 0; let extractFailed = 0; let missingCount = 0;
    let skippedFresh = 0;
    const skippedIds: string[] = [];
    const changedListingIds: string[] = [];
    const errors: Array<{ code: string; message: string; url?: string }> = [];

    try {
      const taxonomy = await getTaxonomy();
      const adapter = getAdapter(shop.adapterKey);
      const robots = shop.crawlPolicy.respectRobots
        ? await loadRobots(shop.baseUrl, shop.crawlPolicy.userAgent ?? config.userAgent)
        : null;

      const built = await buildAdapterContext({
        shop, runId, correlationId,
        userAgent: config.userAgent,
        ...(config.contactEmail ? { contactEmail: config.contactEmail } : {}),
        allowBrowser: config.mode === 'browser' || config.mode === 'all',
        robots,
        resolvers: resolversFor(taxonomy),
        saveArtifact: (name, content, contentType) => saveArtifact(config, runId, name, content, contentType),
        limits: { maxUrls: config.maxUrlsPerRun, maxDurationMs: config.maxRunDurationMs, maxPages: 5000 },
      });
      const ctx: AdapterContext = built.ctx;

      // ── 1. Katalogus felderitese ───────────────────────────────────────
      const discovery = await adapter.discover(ctx);
      status = discovery.status;
      errors.push(...discovery.diagnostics.errors);

      logger.info('discovery.targets', {
        shopKey: shop.key, targets: discovery.targets.length,
        completeness: discovery.completeness, status,
      });

      if (status === 'blocked' || status === 'policy_disabled') {
        await raiseAlert({
          key: `discovery:blocked:${shop.key}`,
          level: 'error', category: 'crawler', shopId,
          title: `A ${shop.name} forras blokkolt`,
          message: `A discovery ${status} statusszal zarult. Errors: ${errors.map((e) => e.code).join(', ')}`,
          detail: { runId, errors },
        });
      }

      // ── 2. Termekoldalak kinyerese ─────────────────────────────────────
      //
      // A futas idokorlatos, es a `gentle` policy 0,5 keres/mp uteme mellett
      // 40 perc pontosan 1200 kerest jelent. Ha minden futas a lista elejerol
      // indulna, a katalogus 1200 utani resze SOHA nem kerulne sorra - ezert
      // a futas ott folytatja, ahol az elozo abbahagyta, es a lista vegen
      // korbefordul.
      const seenListingIds = new Set<string>();
      const concurrency = Math.max(1, shop.crawlPolicy.maxConcurrency);
      const allTargets = discovery.targets;

      const rotation = rotateTargets(allTargets, resumeState.resumeUrl);
      const targets = rotation.targets;

      logger.info('discovery.resume', {
        shopKey: shop.key, targets: targets.length, startIndex: rotation.startIndex,
        resumedFrom: rotation.startIndex > 0 ? resumeState.resumeUrl : null,
        ...(rotation.resumePointLost
          ? { warning: 'A folytatasi URL mar nincs a cellistaban; az elejerol kezdunk.' }
          : {}),
      });

      // A mar ismert, friss listingeket atugorjuk. Az atugras NEM keres, ezert
      // nem fogyasztja az idokeretet - a futas igy atsuhan a katalogus ismert
      // reszen, es a teljes keretet uj termekekre kolti.
      const known = config.discoverySkipFreshHours > 0
        ? await loadKnownListings(shopId, config.discoverySkipFreshHours)
        : null;

      let index = 0;
      /** A legkisebb index, ameddig az idokorlat miatt NEM jutottunk el. */
      let cutoffIndex: number | null = null;

      // Szivveres: az utemezo ebbol ismeri fel a megszakadt futast. Idoalapu,
      // nem elemszamalapu - egy lassu forrasnal a kettő nem ugyanaz, es a
      // ritkitott letoltes miatt konnyen percekig nem lenne eletjel.
      let lastBeat = Date.now();
      const beat = async (): Promise<void> => {
        if (Date.now() - lastBeat < HEARTBEAT_INTERVAL_MS) return;
        lastBeat = Date.now();
        await execute('UPDATE crawl_runs SET heartbeat_at = now() WHERE id = $1', [runId])
          .catch(() => undefined);   // az eletjel elmaradasa ne bontsa meg a futast
      };

      const workerLoop = async (): Promise<void> => {
        for (;;) {
          const i = index++;
          if (i >= targets.length) return;

          // Az atugras-vizsgalat MEGELOZI az idokorlatot: ingyenes lepesek
          // nem eshetnek aldozatul az orának.
          const candidate = targets[i]!;
          if (known && !candidate.inlineListing) {
            const hit = known.lookup(candidate);
            if (hit && known.isFresh(hit)) {
              seenListingIds.add(hit.id);
              skippedIds.push(hit.id);
              skippedFresh++;
              continue;
            }
          }

          if (Date.now() - started > config.maxRunDurationMs) {
            status = 'partial';
            // Tobb parhuzamos szal is ideerhet; a legkisebb index a helyes
            // folytatasi pont. A meg futo keresek ujrafeldolgozasa artalmatlan,
            // mert a perzisztalas idempotens.
            cutoffIndex = cutoffIndex === null ? i : Math.min(cutoffIndex, i);
            return;
          }

          await beat();

          const target = candidate;
          try {
            const result = await adapter.extractListing(ctx, target);
            if (result.status !== 'ok' || !result.listing) {
              extractFailed++;
              if (result.diagnostics.errors?.length) {
                errors.push(...result.diagnostics.errors.slice(0, 1));
              }
              if (result.rawArtifact && ctx.saveArtifact) {
                await ctx.saveArtifact(
                  `extract-fail-${i}.html`, result.rawArtifact.content, result.rawArtifact.contentType,
                ).catch(() => undefined);
              }
              continue;
            }
            extractOk++;

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
            seenListingIds.add(persisted.listingId);
            if (persisted.isNew) { newCount++; changedListingIds.push(persisted.listingId); }
            else if (persisted.changed) { updatedCount++; changedListingIds.push(persisted.listingId); }
            else unchangedCount++;
          } catch (err) {
            extractFailed++;
            const message = err instanceof Error ? err.message : String(err);
            errors.push({ code: 'EXTRACT_EXCEPTION', message, url: target.url });
            logger.warn('discovery.extract_failed', { url: target.url, error: message });
          }
        }
      };

      await Promise.all(Array.from({ length: concurrency }, () => workerLoop()));

      // Az atugrott listingeket LATTUK a katalogusban - csak nem toltottuk le
      // ujra. A last_seen_at frissitese nelkul a kor-alapu eltunt-jeloles
      // tevesen "eltunt"-nek jelolne oket.
      if (skippedIds.length) {
        await execute(
          `UPDATE source_listings SET last_seen_at = now() WHERE id = ANY($1::uuid[])`,
          [skippedIds],
        );
        logger.info('discovery.skipped_fresh', {
          shopKey: shop.key,
          atugrott: skippedFresh,
          letoltott: extractOk + extractFailed,
          ok: `Mar ismert es ${config.discoverySkipFreshHours} oran belul sikeresen kinyert termekek. `
            + 'Az aruk frissiteserol a known-listing-refresh sor gondoskodik.',
        });
      }

      // ── 3. A kor allapotanak rogzitese ─────────────────────────────────
      // Ha az idokorlat vagott el minket, elmentjuk a kovetkezo feldolgozatlan
      // cel URL-jet; ha vegigertunk a teljes listan, a kor lezarul.
      // Lokalis konstans: a cutoffIndex closure-ben irodik, ezert a fordito
      // csak igy tudja szukiteni a tipusat.
      const cutoff: number | null = cutoffIndex;
      const cycleCompleted = cutoff === null;
      if (cycleCompleted) {
        await execute(
          `UPDATE shops SET discovery_resume_url = NULL, discovery_cycle_started_at = now()
            WHERE id = $1`,
          [shopId],
        );
      } else {
        const nextUrl = targets[cutoff]?.url ?? null;
        await execute(
          `UPDATE shops
              SET discovery_resume_url = $2,
                  discovery_cycle_started_at = coalesce(discovery_cycle_started_at, $3)
            WHERE id = $1`,
          [shopId, nextUrl, cycleStartedAt],
        );
        logger.info('discovery.partial_cutoff', {
          shopKey: shop.key,
          feldolgozott: cutoff,
          hatralevo: targets.length - cutoff,
          folytatas: nextUrl,
          ok: `Idokorlat (${Math.round(config.maxRunDurationMs / 60000)} perc). A kovetkezo futas innen folytatja.`,
        });
      }

      // ── 4. Eltunt listingek jelolese ───────────────────────────────────
      // CSAK teljes, egeszseges KOR utan (spec 16.1). Korkoros feldolgozasnal
      // egyetlen futas sem latja a teljes katalogust, ezert a helyes
      // osszehasonlitasi alap a KOR kezdete, nem a futase.
      if (cycleCompleted && discovery.completeness === 'complete' && status === 'ok') {
        const missing = await query<{ id: string }>(
          `SELECT id FROM source_listings
            WHERE shop_id = $1 AND listing_status = 'active'
              AND last_seen_at < $2`,
          [shopId, cycleStartedAt],
        );
        for (const row of missing) {
          await markListingMissing(row.id, 'Nem szerepelt a teljes katalogus-korben.');
          missingCount++;
        }
      } else {
        logger.info('discovery.skip_missing_detection', {
          shopKey: shop.key,
          reason: cycleCompleted
            ? `A futas ${status}, ezert nem jelolunk eltunt listinget.`
            : 'A katalogus-kor meg nem zarult le, ezert nem jelolunk eltunt listinget.',
        });
      }

      // ── 4. Quality gate (spec 31.1) ────────────────────────────────────
      const catalogAfter = await queryOne<{ count: number }>(
        `SELECT count(*)::int AS count FROM source_listings
          WHERE shop_id = $1 AND listing_status = 'active'`,
        [shopId],
      );
      const shopRow = await queryOne<{
        expected_catalog_min: number | null; expected_catalog_max: number | null;
        catalog_drop_tolerance_pct: number;
      }>(
        `SELECT expected_catalog_min, expected_catalog_max, catalog_drop_tolerance_pct
           FROM shops WHERE id = $1`, [shopId],
      );

      const gate = await runShopQualityGate({
        shopId, crawlRunId: runId,
        catalogSizeBefore: catalogBefore?.count ?? null,
        catalogSizeAfter: catalogAfter?.count ?? 0,
        completeness: discovery.completeness,
        extractOk, extractFailed,
        maxCatalogDropPct: shopRow?.catalog_drop_tolerance_pct ?? gateConfig.maxCatalogDropPct ?? 20,
        minParserSuccessRate: gateConfig.minParserSuccessRate ?? 0.85,
        expectedCatalogMin: shopRow?.expected_catalog_min ?? null,
        expectedCatalogMax: shopRow?.expected_catalog_max ?? null,
      });

      const finalStatus = !gate.passed ? 'quarantined'
        : status === 'ok' ? 'succeeded'
          : status === 'partial' ? 'partial' : 'failed';

      await execute(
        `UPDATE crawl_runs SET
           status = $2, source_status = $3, finished_at = now(),
           duration_ms = $4, requests_attempted = $5, requests_succeeded = $6,
           requests_failed = $7, requests_retried = $8, rate_limit_hits = $9,
           pages_seen = $10, urls_discovered = $11, urls_duplicate = $12,
           listings_new = $13, listings_updated = $14, listings_unchanged = $15,
           listings_missing = $16, extract_ok = $17, extract_failed = $18,
           http_status_counts = $19::jsonb, catalog_size_after = $20, catalog_hash = $21,
           completeness = $22, robots_decision = $23, browser_used = $24,
           quality_gate_passed = $25, quality_gate_report = $26::jsonb,
           quarantine_reason = $27, published_at = CASE WHEN $25 THEN now() ELSE NULL END,
           errors = $28::jsonb,
           warnings = $29::jsonb
         WHERE id = $1`,
        [
          runId, finalStatus, status, Date.now() - started,
          built.diagnostics.requestsAttempted + discovery.diagnostics.requestsAttempted,
          built.diagnostics.requestsSucceeded, built.diagnostics.requestsFailed,
          built.diagnostics.requestsRetried, built.diagnostics.rateLimitHits,
          discovery.diagnostics.pagesSeen, discovery.targets.length,
          discovery.diagnostics.urlsDuplicate,
          newCount, updatedCount, unchangedCount, missingCount, extractOk, extractFailed,
          JSON.stringify(built.diagnostics.httpStatusCounts),
          catalogAfter?.count ?? 0, discovery.catalogHash ?? null,
          discovery.completeness, built.diagnostics.robotsDecision,
          built.diagnostics.browserUsed,
          gate.passed, JSON.stringify({ checks: gate.checks }), gate.reason,
          JSON.stringify(errors.slice(0, 50)),
          JSON.stringify([
            ...discovery.diagnostics.notes,
            ...discovery.completenessEvidence,
          ]),
        ],
      );

      await execute(
        `UPDATE shops SET
           health_status = $2,
           health_checked_at = now(),
           last_successful_discovery_at = CASE WHEN $3 THEN now() ELSE last_successful_discovery_at END,
           next_discovery_at = now() + (discovery_interval_hours || ' hours')::interval
         WHERE id = $1`,
        [
          shopId,
          finalStatus === 'succeeded' ? 'ok'
            : finalStatus === 'partial' ? 'degraded'
              : status === 'blocked' ? 'blocked' : 'failing',
          finalStatus === 'succeeded',
        ],
      );

      if (!gate.passed) {
        await raiseAlert({
          key: `quality_gate:shop:${shop.key}`,
          level: 'error', category: 'quality_gate', shopId,
          title: `A ${shop.name} quality gate-je megbukott`,
          message: gate.reason ?? 'ismeretlen ok',
          detail: { runId, checks: gate.checks },
        });
      }

      // ── 5. Az uj/modosult listingek klaszterezese (spec 5.2/5) ────────
      for (const listingId of changedListingIds.slice(0, config.maxClusterJobsPerRun)) {
        await enqueueFromWorker(config, {
          queue: 'candidate-generation', name: 'cluster-listing',
          payload: { sourceListingId: listingId, trigger: 'discovery' },
          idempotencyKey: `cluster:${listingId}`,
          shopId, crawlRunId: runId, correlationId,
        });
      }

      metrics.counter('discovery.listings_new', newCount, { shop: shop.key });
      metrics.counter('discovery.listings_updated', updatedCount, { shop: shop.key });
      metrics.timing('discovery.duration_ms', Date.now() - started, { shop: shop.key });

      return {
        runId, status: finalStatus, sourceStatus: status,
        targets: discovery.targets.length,
        newCount, updatedCount, unchangedCount, missingCount,
        extractOk, extractFailed,
        gatePassed: gate.passed, gateReason: gate.reason,
        clusterJobsQueued: Math.min(changedListingIds.length, config.maxClusterJobsPerRun),
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await execute(
        `UPDATE crawl_runs SET status = 'failed', source_status = 'unavailable',
                finished_at = now(), duration_ms = $2, errors = $3::jsonb
          WHERE id = $1`,
        [runId, Date.now() - started, JSON.stringify([{ code: 'RUN_EXCEPTION', message }])],
      );
      await execute(`UPDATE shops SET health_status = 'failing', health_checked_at = now() WHERE id = $1`, [shopId]);
      await raiseAlert({
        key: `discovery:exception:${shopId}`,
        level: 'error', category: 'crawler', shopId,
        title: 'Discovery futas kivetellel leallt',
        message, detail: { runId },
      });
      throw err;
    }
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// Health check
// ═══════════════════════════════════════════════════════════════════════════

export async function processHealthCheck(job: Job<DiscoveryPayload>, config: WorkerConfig): Promise<unknown> {
  const { shopId } = job.data;
  const correlationId = job.data.correlationId ?? newCorrelationId();

  return withContext({ correlationId, shopId }, async () => {
    const shop = await loadShop(shopId);
    if (!shop) throw new Error(`Ismeretlen webshop: ${shopId}`);

    const taxonomy = await getTaxonomy();
    const adapter = getAdapter(shop.adapterKey);
    const robots = await loadRobots(shop.baseUrl, shop.crawlPolicy.userAgent ?? config.userAgent);

    const run = await queryOne<{ id: string }>(
      `INSERT INTO crawl_runs (shop_id, run_type, trigger, status, adapter_key, adapter_version, correlation_id)
       VALUES ($1,'health_check',$2,'running',$3,$4,$5) RETURNING id`,
      [shopId, job.data.trigger ?? 'scheduler', shop.adapterKey, shop.adapterVersion, correlationId],
    );
    const runId = run!.id;
    const started = Date.now();

    const built = await buildAdapterContext({
      shop, runId, correlationId,
      userAgent: config.userAgent,
      ...(config.contactEmail ? { contactEmail: config.contactEmail } : {}),
      allowBrowser: false, robots,
      resolvers: resolversFor(taxonomy),
      limits: { maxUrls: 20, maxDurationMs: 120_000, maxPages: 10 },
    });

    const result = await adapter.healthCheck(built.ctx);

    await execute(
      `UPDATE crawl_runs SET status = $2, source_status = $3, finished_at = now(),
              duration_ms = $4, warnings = $5::jsonb
        WHERE id = $1`,
      [
        runId, result.healthy ? 'succeeded' : 'failed', result.status,
        Date.now() - started, JSON.stringify(result.checks),
      ],
    );

    await execute(
      `UPDATE shops SET health_status = $2, health_checked_at = now(), health_detail = $3::jsonb,
              robots_last_checked_at = now(), robots_allows_crawl = $4
        WHERE id = $1`,
      [
        shopId,
        result.healthy ? 'ok' : result.status === 'blocked' ? 'blocked' : 'failing',
        JSON.stringify({ checks: result.checks, platform: result.detectedPlatform, message: result.message }),
        robots ? true : null,
      ],
    );

    if (!result.healthy) {
      await raiseAlert({
        key: `health:${shop.key}`,
        level: result.status === 'blocked' ? 'error' : 'warn',
        category: 'crawler', shopId,
        title: `A ${shop.name} health checkje sikertelen`,
        message: result.message ?? result.status,
        detail: { checks: result.checks },
      });
    }

    return { runId, healthy: result.healthy, status: result.status, checks: result.checks };
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// Egyedi URL lekerese (review-bol)
// ═══════════════════════════════════════════════════════════════════════════

export interface FetchUrlPayload {
  url: string;
  urlKey: string;
  shopId: string;
  canonicalVariantId?: string | null;
  trigger?: string;
  correlationId?: string;
}

export async function processFetchUrl(job: Job<FetchUrlPayload>, config: WorkerConfig): Promise<unknown> {
  const { url, shopId } = job.data;
  const correlationId = job.data.correlationId ?? newCorrelationId();

  return withContext({ correlationId, shopId }, async () => {
    const shop = await loadShop(shopId);
    if (!shop) throw new Error(`Ismeretlen webshop: ${shopId}`);

    const taxonomy = await getTaxonomy();
    const adapter = getAdapter(shop.adapterKey);
    const settings = await getSettings();
    const pricing = (settings.settings.get('pricing.comparison') ?? {}) as { allowedPriceTypes?: string[] };

    const run = await queryOne<{ id: string }>(
      `INSERT INTO crawl_runs (shop_id, run_type, trigger, status, adapter_key, adapter_version, correlation_id)
       VALUES ($1,'single_url',$2,'running',$3,$4,$5) RETURNING id`,
      [shopId, job.data.trigger ?? 'review', shop.adapterKey, shop.adapterVersion, correlationId],
    );
    const runId = run!.id;

    const built = await buildAdapterContext({
      shop, runId, correlationId,
      userAgent: config.userAgent,
      ...(config.contactEmail ? { contactEmail: config.contactEmail } : {}),
      allowBrowser: config.mode !== 'http',
      resolvers: resolversFor(taxonomy),
      limits: { maxUrls: 1, maxDurationMs: 90_000, maxPages: 3 },
    });

    const target: DiscoveredTarget = { url };
    const result = await adapter.extractListing(built.ctx, target);

    if (result.status !== 'ok' || !result.listing) {
      await execute(
        `UPDATE crawl_runs SET status = 'failed', source_status = $2, finished_at = now(),
                errors = $3::jsonb WHERE id = $1`,
        [runId, result.status === 'blocked' ? 'blocked' : 'parse_error',
          JSON.stringify(result.diagnostics.errors ?? [])],
      );
      return { ok: false, status: result.status, runId, errors: result.diagnostics.errors };
    }

    const categoryId = await categoryIdForKey(result.listing.identity.categoryKey);
    const persisted = await persistListing({
      shopId, crawlRunId: runId, listing: result.listing,
      comparisonPolicy: {
        allowedPriceTypes: (pricing.allowedPriceTypes ?? ['regular', 'sale']) as never,
        requireInStock: false,
      },
      categoryId,
    });

    await execute(
      `UPDATE crawl_runs SET status = 'succeeded', source_status = 'ok', finished_at = now(),
              extract_ok = 1, listings_new = $2, listings_updated = $3 WHERE id = $1`,
      [runId, persisted.isNew ? 1 : 0, persisted.isNew ? 0 : 1],
    );

    // Ha review-bol jott konkret kanonikus valtozattal, azonnal kiertekeljuk
    await enqueueFromWorker(config, {
      queue: 'candidate-generation', name: 'cluster-listing',
      payload: {
        sourceListingId: persisted.listingId,
        preferredVariantId: job.data.canonicalVariantId ?? null,
        trigger: 'manual_url',
      },
      idempotencyKey: `cluster:${persisted.listingId}:manual`,
      shopId, correlationId,
    });

    return {
      ok: true, runId, listingId: persisted.listingId, isNew: persisted.isNew,
      name: result.listing.rawName,
      price: result.listing.price.selectedComparablePriceHuf,
      extractionQuality: result.listing.extractionQuality,
      warnings: result.listing.parseWarnings,
    };
  });
}
