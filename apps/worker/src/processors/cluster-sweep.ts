/**
 * A klaszterezesi hatralek kotegelt feldolgozasa.
 *
 * A rendszerben ma nincs sopres: a `cluster-listing` job kizarolag esemenyre
 * indul - egy felderites vegen, egy ujrakinyeres utan, vagy kezi keresre.
 * Ami korabban keletkezett es kimaradt, az orokre `unclustered` marad, mert
 * senki nem veszi elo.
 *
 * Husz-ezer tetellel ez azt jelenti, hogy a katalogus nagy resze egyszeruen
 * nem is jut el a parositasig. Ez a processzor koteg-szeruen halad rajta.
 *
 * Ket dolog teszi biztonsagossa a nagy meret mellett:
 *
 *  - A `cluster_status` MAGA a kurzor. Nem tarolunk kulon pozíciot, amit egy
 *    megszakadt futas elronthatna: ami mar `clustered` vagy `needs_review`,
 *    az kiesik a kovetkezo kotegbol.
 *  - A sorbaallitas idempotens (`cluster:<listingId>` kulcs), ezert egy
 *    ismetelt futas nem duplikal jobot.
 */
import type { Job } from 'bullmq';
import { query } from '@radovin/db';
import { logger, newCorrelationId, withContext } from '@radovin/observability';
import type { WorkerConfig } from '../config.js';
import { enqueueFromWorker } from '../lib/queue-client.js';

/** Egy koteg felso hatara. A scheduler ismetli, amig van hatralek. */
const DEFAULT_BATCH = 300;

export interface ClusterSweepPayload {
  /** Hany listinget alljon sorba ez a futas. */
  limit?: number;
  /** Egyetlen webshopra szukites (kulcs szerint). */
  shopKey?: string;
  /** Csak a bor-boltokra. Alapertelmezes: minden aktiv bolt. */
  segments?: string[];
  correlationId?: string;
}

export async function processClusterSweep(
  job: Job<ClusterSweepPayload>,
  config: WorkerConfig,
): Promise<unknown> {
  const correlationId = job.data.correlationId ?? newCorrelationId();
  const limit = Math.min(job.data.limit ?? DEFAULT_BATCH, config.maxClusterJobsPerRun);

  return withContext({ correlationId }, async () => {
    const params: unknown[] = [];
    const filters: string[] = [];
    if (job.data.shopKey) {
      params.push(job.data.shopKey);
      filters.push(`AND s.key = $${params.length}`);
    }
    if (job.data.segments?.length) {
      params.push(job.data.segments);
      filters.push(`AND s.segment = ANY($${params.length}::text[])`);
    }
    params.push(limit);

    // A sorrend szandekos: eloszor azok a listingek, amiknek MAR van
    // feloldott termeloje. Azoknal van esely valodi parositasra - a termelo
    // a bor kategoriaban kotelezo mezo. A tobbi utanuk jon, hogy a
    // katalogus tisztitasa se alljon meg.
    const rows = await query<{ id: string }>(
      `SELECT sl.id::text
         FROM source_listings sl
         JOIN shops s ON s.id = sl.shop_id
        WHERE sl.listing_status = 'active'
          AND sl.cluster_status = 'unclustered'
          AND s.active AND NOT s.policy_disabled
          ${filters.join(' ')}
        ORDER BY (sl.producer_id IS NULL), sl.id
        LIMIT $${params.length}`,
      params,
    );

    let queued = 0;
    for (const r of rows) {
      const id = await enqueueFromWorker(config, {
        queue: 'candidate-generation', name: 'cluster-listing',
        payload: { sourceListingId: r.id, trigger: 'sweep' },
        idempotencyKey: `cluster:${r.id}`,
        correlationId,
      });
      if (id) queued++;
    }

    const remaining = await query<{ count: number }>(
      `SELECT count(*)::int AS count
         FROM source_listings sl
         JOIN shops s ON s.id = sl.shop_id
        WHERE sl.listing_status = 'active'
          AND sl.cluster_status = 'unclustered'
          AND s.active AND NOT s.policy_disabled`,
    );

    logger.info('cluster_sweep.done', {
      sorbaallitva: queued,
      hatralek: remaining[0]?.count ?? 0,
      koteg: limit,
    });

    return {
      queued,
      remaining: remaining[0]?.count ?? 0,
      batchSize: limit,
    };
  });
}
