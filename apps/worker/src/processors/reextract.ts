/**
 * Ujrakinyeres a mar begyujtott nevekbol - ujracrawl NELKUL.
 *
 * A boraszat jovahagyasa onmagaban semmit nem valtoztat a katalogusen: a
 * `source_listings.producer_id` uresen marad, amig valaki ujra ki nem nyeri
 * az azonossagot. Eddig ehhez a kovetkezo teljes felderitesre kellett varni -
 * pedig a nevhez mar nem kell a webshop, a `raw_name` ott van a sorban.
 *
 * Ket uzemmod:
 *   - CELZOTT (`producerIds`): csak azok a listingek, amikben a MOST
 *     jovahagyott boraszatok neve elofordul. Ez teszi reszlegesse a
 *     jovahagyast: nem kell az osszes jeloltet vegignezni ahhoz, hogy az
 *     elso nehany hasson.
 *   - TELJES (`all`): minden bor-listing, amiben barmelyik AKTIV boraszat
 *     neve elofordul.
 *
 * A `normalized_name LIKE '%nev%'` csak ELOSZURES: olcso, es a trigram GIN
 * index kiszolgalja. A dontest a parser hozza, tokenhataron - ezert a
 * tulzottan bo eloszures csak processzoridobe kerul, teves talalatot nem ad.
 */
import type { Job } from 'bullmq';
import { execute, query, transaction } from '@radovin/db';
import { logger, newCorrelationId, withContext } from '@radovin/observability';
import { parseWineName } from '@radovin/domain';
import type { WorkerConfig } from '../config.js';
import { loadWineVocabulary } from '../lib/wine-vocab.js';
import { applyWineIdentity, type WineListingRow, type WineLookups } from '../lib/wine-apply.js';
import { enqueueFromWorker } from '../lib/queue-client.js';

/** Csak a bor-boltok: a tomeny listingjein a borszotar nem ertelmezheto. */
const WINE_SHOP_SEGMENTS = ['wine', 'mixed'];

/** Egy tranzakcio ennyi listinget dolgoz fel. */
const CHUNK = 200;

export interface ReextractPayload {
  /** Celzott mod: csak ezekhez a boraszatokhoz tartozo listingek. */
  producerIds?: string[];
  /**
   * A jovahagyott, de meg nem alkalmazott boraszatok. Ez az alapertelmezett
   * mod a jovahagyas utan: egy rovid keslelteteshez kotve egyetlen futasba
   * gyujti ossze az egymas utan jovahagyott boraszatokat.
   */
  pendingOnly?: boolean;
  /** Teljes mod: minden aktiv boraszat. A `producerIds` erosebb. */
  all?: boolean;
  /** Egyetlen webshopra szukites (kulcs szerint). */
  shopKey?: string;
  /** Feldolgozando listingek felso hatara. */
  limit?: number;
  /** Sorba allitsuk-e a valtozott sorok klaszterezeset. Alapertelmezes: igen. */
  cluster?: boolean;
  /** Irasa nelkul: csak megszamolja, mi valtozna. */
  dryRun?: boolean;
  correlationId?: string;
}

const LISTING_SELECT = `
  SELECT sl.id::text, sl.raw_name, sl.category_id::text,
         sl.platform_product_id, sl.platform_variant_id,
         sl.producer_id::text, pr.canonical_name AS producer_name,
         sl.brand_id::text, br.canonical_name AS brand_name,
         sl.expression, sl.vintage_value, sl.vintage_status, sl.age_statement_years,
         sl.volume_ml, sl.pack_count, sl.packaging_type, sl.edition, sl.cask_finish,
         sl.dosage_style, sl.puttony, sl.gtin, sl.colour,
         sl.wine_style_id::text, sl.vineyard_id::text, sl.wine_region_id::text,
         sl.grape_signature, g.ids AS grape_ids
    FROM source_listings sl
    JOIN shops s ON s.id = sl.shop_id
    LEFT JOIN producers pr ON pr.id = sl.producer_id
    LEFT JOIN brands br ON br.id = sl.brand_id
    LEFT JOIN LATERAL (
      SELECT array_agg(slg.grape_variety_id::text) AS ids
        FROM source_listing_grapes slg
       WHERE slg.source_listing_id = sl.id
    ) g ON true
`;

export async function processReextract(
  job: Job<ReextractPayload>,
  config: WorkerConfig,
): Promise<unknown> {
  const correlationId = job.data.correlationId ?? newCorrelationId();
  let scoped = job.data.producerIds?.length ? job.data.producerIds : null;
  const limit = Math.min(job.data.limit ?? 20_000, 50_000);
  const doCluster = job.data.cluster !== false;
  const dryRun = job.data.dryRun === true;

  return withContext({ correlationId }, async () => {
    if (!scoped && job.data.pendingOnly) {
      const pending = await query<{ id: string }>(
        `SELECT id::text FROM producers
          WHERE status = 'active' AND applied_at IS NULL
          ORDER BY decided_at`,
      );
      if (!pending.length) {
        return { skipped: true, reason: 'nothing_pending' };
      }
      scoped = pending.map((p) => p.id);
    }

    if (!scoped && !job.data.all) {
      return { skipped: true, reason: 'no_scope', hint: 'producerIds, pendingOnly vagy all kell.' };
    }

    const { vocab, counts } = await loadWineVocabulary();
    if (!counts.producer) {
      logger.warn('reextract.no_producers', {
        hint: 'Egyetlen aktiv boraszat sincs - a jovahagyas nelkul nincs mit alkalmazni.',
      });
      return { skipped: true, reason: 'no_active_producers' };
    }

    // Szinlevezetes: a bortipus mondja ki, hianyaban az egyertelmu fajtaszin.
    const [styles, grapes, wineCat] = await Promise.all([
      query<{ id: string; colour: string | null }>(
        `SELECT id::text, colour FROM wine_styles WHERE status = 'active'`),
      query<{ id: string; colour_default: string | null }>(
        `SELECT id::text, colour_default FROM grape_varieties WHERE status = 'active'`),
      query<{ id: string }>(`SELECT id::text FROM product_categories WHERE key = 'wine'`),
    ]);
    const lookups: WineLookups = {
      styleColour: new Map(styles.map((s) => [s.id, s.colour])),
      grapeColour: new Map(grapes.map((g) => [g.id, g.colour_default])),
      wineCategoryId: wineCat[0]?.id ?? null,
    };

    // Az eloszures: azok a sorok, amikben egy szoba joheto boraszat neve
    // egyaltalan elofordul. A `p.name_norm` generalt oszlop, es a
    // `source_listings.normalized_name` is - a LIKE mindkettovel normalizalt
    // alakon dolgozik, tehat az ekezet es a kisbetu mar nem szamit.
    const params: unknown[] = [WINE_SHOP_SEGMENTS];
    let producerFilter: string;
    if (scoped) {
      params.push(scoped);
      producerFilter = `p.id = ANY($${params.length}::uuid[]) AND p.status = 'active'`;
    } else {
      producerFilter = `p.status = 'active'`;
    }
    let shopFilter = '';
    if (job.data.shopKey) {
      params.push(job.data.shopKey);
      shopFilter = `AND s.key = $${params.length}`;
    }
    params.push(limit);

    const rows = await query<WineListingRow>(
      `${LISTING_SELECT}
        WHERE sl.listing_status = 'active'
          AND s.segment = ANY($1::text[])
          ${shopFilter}
          AND EXISTS (
            SELECT 1 FROM producers p
             WHERE ${producerFilter}
               AND sl.normalized_name LIKE '%' || p.name_norm || '%'
          )
        ORDER BY sl.id
        LIMIT $${params.length}`,
      params,
    );

    const scopedSet = scoped ? new Set(scoped) : null;
    let changed = 0;
    let unchanged = 0;
    let noProducer = 0;
    const changedIds: string[] = [];
    /** Boraszatonkent hany listingen ismertuk fel. */
    const hits = new Map<string, number>();
    const fieldCounts = new Map<string, number>();

    for (let offset = 0; offset < rows.length; offset += CHUNK) {
      const chunk = rows.slice(offset, offset + CHUNK);

      await transaction(async (client) => {
        for (const row of chunk) {
          const parsed = parseWineName(row.raw_name, vocab, { producerId: row.producer_id });

          // Boraszat nelkul nincs mit alkalmazni: a bor kategoriaban a
          // termelo KOTELEZO mezo, tehat producer nelkul a sor ugysem tudna
          // parosodni - a fajta beirasa viszont felesleges irasi terheles.
          if (!parsed.producer) { noProducer++; continue; }
          // Celzott modban CSAK a most jovahagyottakat ismerjuk el. Az
          // eloszures ennel bovebb: egy masik, korabban jovahagyott boraszat
          // neve is elofordulhat ugyanabban a nevben.
          if (scopedSet && !scopedSet.has(parsed.producer.id)) { noProducer++; continue; }

          hits.set(parsed.producer.id, (hits.get(parsed.producer.id) ?? 0) + 1);

          if (dryRun) {
            if (parsed.producer.id !== row.producer_id) changed++; else unchanged++;
            continue;
          }

          const result = await applyWineIdentity(client, row, parsed, lookups);
          if (!result.changed) { unchanged++; continue; }
          changed++;
          changedIds.push(row.id);
          for (const f of result.fields) fieldCounts.set(f, (fieldCounts.get(f) ?? 0) + 1);
        }
      });
    }

    // A boraszat "alkalmazva" jelzese. Ezt mutatja a felulet: enelkul nem
    // lehet megkulonboztetni a "jovahagytam, de meg nem hatott" es a
    // "lefutott, de nincs ra termek" allapotot - pedig a ketto mas teendo.
    if (!dryRun) {
      const appliedIds = scoped ?? [...hits.keys()];
      for (const id of appliedIds) {
        await execute(
          `UPDATE producers SET applied_at = now(), applied_listing_count = $2
            WHERE id = $1 AND status = 'active'`,
          [id, hits.get(id) ?? 0],
        );
      }
    }

    // A valtozott sorok ujra elbiralasa. Ez az a lepes, amitol a ket webshop
    // ugyanazon bora megjelenik a parositas-ellenorzesben.
    let queued = 0;
    if (doCluster && !dryRun) {
      for (const id of changedIds) {
        const jobId = await enqueueFromWorker(config, {
          queue: 'candidate-generation', name: 'cluster-listing',
          payload: { sourceListingId: id, trigger: 'reextract' },
          idempotencyKey: `cluster:${id}`,
          correlationId,
        });
        if (jobId) queued++;
      }
    }

    // Onjavito farok. A `pendingOnly` futas a SAJAT INDULASAKOR olvasta ki a
    // varolistat; ha kozben jovahagytak meg egyet, arra a jovahagyas
    // sorbaallitasa mar deduplikalodott a most futo jobra. Ezert a vegen
    // ujraellenorizzuk, es ha maradt, inditunk meg egy kort.
    if (job.data.pendingOnly && !dryRun) {
      const left = await query<{ count: number }>(
        `SELECT count(*)::int AS count FROM producers
          WHERE status = 'active' AND applied_at IS NULL`,
      );
      if ((left[0]?.count ?? 0) > 0) {
        await enqueueFromWorker(config, {
          queue: 'product-ingest', name: 'reextract-listings',
          payload: { pendingOnly: true },
          idempotencyKey: 'reextract-pending-tail',
          delayMs: 10_000, correlationId,
        });
      }
    }

    logger.info('reextract.done', {
      mod: scoped ? 'celzott' : 'teljes',
      boraszatok: scoped?.length ?? counts.producer,
      vizsgalt: rows.length,
      valtozott: changed,
      valtozatlan: unchanged,
      boraszat_nelkul: noProducer,
      klaszterezesre_kuldve: queued,
      mezok: Object.fromEntries(fieldCounts),
      dryRun,
    });

    return {
      scanned: rows.length,
      changed,
      unchanged,
      withoutProducer: noProducer,
      queuedForClustering: queued,
      producersApplied: hits.size,
      fields: Object.fromEntries(fieldCounts),
      dryRun,
    };
  });
}
