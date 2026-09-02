/**
 * Boraszatjeloltek eloallitasa a korpuszbol es beirasa JAVASLATKENT.
 *
 * A `producers` tabla ures, es a bor kategoriaban a `producer` KOTELEZO mezo -
 * amig ures, egyetlen borparositas sem tud sikerulni. Ez a processzor toltı
 * fel jelolteket, de kizarolag `status = 'proposed'` allapotban: eles adatta
 * csak emberi jovahagyassal valnak.
 *
 * A meglevo `active` es `retired` sorokhoz NEM nyul. Egy mar jovahagyott vagy
 * mar elutasitott boraszatot egy ujabb futas nem irhat felul - kulonben a
 * korabbi emberi dontes csendben elveszne.
 */
import type { Job } from 'bullmq';
import { execute, query, queryOne } from '@radovin/db';
import { logger, newCorrelationId, withContext } from '@radovin/observability';
import { parseWineName, mineProducerCandidates, type MineInput } from '@radovin/domain';
import type { WorkerConfig } from '../config.js';
import { loadWineVocabulary } from '../lib/wine-vocab.js';

/**
 * Csak a BOR-boltok. A tomeny boltok listingjei tiszta zajt adnak a
 * rangsorba: az elso meresben a `whisky`, `cask`, `single` tokenek vittek a
 * lista elejet.
 */
const WINE_SHOP_SEGMENTS = ['wine', 'mixed'];

export interface ProposePayload {
  minShops?: number;
  limit?: number;
  correlationId?: string;
}

interface Row {
  shop_key: string;
  raw_name: string;
}

export async function processProposeProducers(
  job: Job<ProposePayload>,
  _config: WorkerConfig,
): Promise<unknown> {
  const correlationId = job.data.correlationId ?? newCorrelationId();
  const minShops = job.data.minShops ?? 2;
  const limit = job.data.limit ?? 400;

  return withContext({ correlationId }, async () => {
    const { vocab } = await loadWineVocabulary();

    const rows = await query<Row>(
      `SELECT s.key AS shop_key, sl.raw_name
         FROM source_listings sl
         JOIN shops s ON s.id = sl.shop_id
        WHERE sl.listing_status = 'active'
          AND s.segment = ANY($1::text[])
          AND length(btrim(sl.raw_name)) > 2`,
      [WINE_SHOP_SEGMENTS],
    );

    const inputs: MineInput[] = [];
    for (const r of rows) {
      const parsed = parseWineName(r.raw_name, vocab);
      const residue = (parsed.expression ?? '').split(' ').filter(Boolean);
      if (!residue.length) continue;
      inputs.push({ shopKey: r.shop_key, rawName: r.raw_name, residueTokens: residue });
    }

    const candidates = mineProducerCandidates(inputs, { minShops, limit });

    // Az INSERT ... ON CONFLICT DO UPDATE mindket agra 1-et ad vissza, ezert a
    // beszuras es a frissites nem kulonboztetheto meg. Ami szamit: beirtuk-e
    // (1) vagy erintetlenul hagytuk, mert mar emberi dontes van rajta (0).
    let written = 0;
    let skipped = 0;

    for (const c of candidates) {
      // A megjelenitett nev: a normalizalt alak nagybetus kezdessel. A pontos
      // irasmodot a jovahagyo javithatja a feluleten.
      const displayName = c.name.replace(/(^|\s)(\p{L})/gu, (_m, sp: string, ch: string) => sp + ch.toUpperCase());

      const evidence = {
        listings: c.count,
        shops: c.shops,
        leadingCount: c.leadingCount,
        hasMarker: c.hasMarker,
        personName: c.personName,
        examples: c.examples,
        minedAt: new Date().toISOString(),
      };

      // Szandekosan NEM `ON CONFLICT`: a `name_norm` generalt oszlop, es a rajta
      // levo egyedi index reszleges (`WHERE status <> 'merged'`). A kifejezett
      // keres-majd-ir szerkezet viselkedese magatol ertetodo, es ugyanazt a
      // vedelmet adja: a mar ELDONTOTT sorokhoz nem nyulunk.
      const existing = await queryOne<{ id: string; status: string }>(
        `SELECT id::text, status FROM producers
          WHERE name_norm = rv_search_norm($1) AND status <> 'merged' LIMIT 1`,
        [displayName],
      );

      if (!existing) {
        await execute(
          `INSERT INTO producers
             (canonical_name, kind, status, fuzzy_blocked, evidence, candidate_score, proposed_at)
           VALUES ($1, 'winery', 'proposed', $2, $3::jsonb, $4, now())`,
          [displayName, c.personName, JSON.stringify(evidence), c.score],
        );
        written++;
      } else if (existing.status === 'proposed') {
        // Meg nem dontottek rola: a friss bizonyitek felulirhatja a regit.
        await execute(
          `UPDATE producers SET
             evidence = $2::jsonb, candidate_score = $3,
             fuzzy_blocked = $4, proposed_at = now()
           WHERE id = $1`,
          [existing.id, JSON.stringify(evidence), c.score, c.personName],
        );
        written++;
      } else {
        // Mar jovahagyott (`active`) vagy mar elutasitott (`retired`) - a
        // korabbi emberi dontest egy ujabb banyaszat nem irhatja felul.
        skipped++;
      }
    }

    const totals = await query<{ status: string; count: number }>(
      `SELECT status, count(*)::int AS count FROM producers GROUP BY status`,
    );

    logger.info('producers.proposed', {
      jeloltek: candidates.length,
      beirt: written,
      mar_eldontott: skipped,
      listing: rows.length,
      allapotok: Object.fromEntries(totals.map((t) => [t.status, t.count])),
      hint: 'A jeloltek `proposed` allapotban vannak. Elesse csak jovahagyas teszi oket.',
    });

    return {
      candidates: candidates.length,
      written,
      skipped,
      listings: rows.length,
    };
  });
}
