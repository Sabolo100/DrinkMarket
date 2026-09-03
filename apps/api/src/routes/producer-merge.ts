/**
 * Boraszatjeloltek osszevonasa.
 *
 * A banyaszat n-gramokbol dolgozik, ezert ugyanarrol a pinceszetrol tobb
 * jeloltet is elohoz - "Sauska Brut", "Sauska Extra Dry", "Sauska Puttonyos" -,
 * es kulon sorra teszi a "Bock"-ot meg a "Bock Pince"-t. Amig ezek kulon
 * `producer` sorok, a boraik KULON termelohoz tartoznak, es a parositas nem
 * tudja osszekotni oket: a `producer` a bor kategoriaban kotelezo azonossag-
 * mezo.
 *
 * A muvelet ket lepesre bomlik, es ez szandekos:
 *
 *   GET  /producers/merge-groups  - javaslat, bizonyitekkal. Nem ir semmit.
 *   POST /producers/merge         - a felhasznalo altal VALASZTOTT osszevonas.
 *
 * Automatikus osszevonas nincs. A "Gere Attila" es a "Gere Zsolt" vezeto
 * tokenje azonos, megis ket kulon boraszat (spec 13.3) - egy gepi dontes itt
 * ket valodi pinceszetet olvasztana egybe.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { query, queryOne, transaction } from '@radovin/db';
import { AppError } from '@radovin/observability';
import { groupMergeCandidates, type MergeMember } from '@radovin/domain';
import type { AppConfig } from '../config.js';
import { requireAtLeast } from '../lib/auth.js';
import { audit } from '../lib/context.js';
import { enqueue, JOB_PRIORITY } from '../lib/queues.js';

interface ProducerRow {
  id: string;
  canonical_name: string;
  status: string;
  fuzzy_blocked: boolean;
  candidate_score: number | null;
  evidence: { personName?: boolean } | null;
  linked_listings: number;
}

const LOAD_SQL = `
  SELECT p.id::text, p.canonical_name, p.status, p.fuzzy_blocked,
         p.candidate_score, p.evidence,
         (SELECT count(*)::int FROM source_listings sl WHERE sl.producer_id = p.id)
           AS linked_listings
    FROM producers p
   WHERE p.status IN ('proposed','active')
`;

function toMember(r: ProducerRow): MergeMember {
  return {
    id: r.id,
    canonicalName: r.canonical_name,
    status: r.status,
    linkedListings: r.linked_listings,
    candidateScore: r.candidate_score === null ? null : Number(r.candidate_score),
    personName: Boolean(r.evidence?.personName),
    fuzzyBlocked: r.fuzzy_blocked,
  };
}

export async function producerMergeRoutes(app: FastifyInstance, config: AppConfig): Promise<void> {
  // ── Javaslatok ───────────────────────────────────────────────────────────
  app.get('/producers/merge-groups', async (req) => {
    requireAtLeast(req.user, 'catalog_manager');
    const q = z.object({
      confidence: z.enum(['high', 'medium', 'all']).optional(),
      search: z.string().optional(),
      limit: z.coerce.number().int().min(1).max(500).optional(),
    }).parse(req.query);

    const rows = await query<ProducerRow>(LOAD_SQL);
    let groups = groupMergeCandidates(rows.map(toMember));

    if (q.confidence && q.confidence !== 'all') {
      groups = groups.filter((g) => g.confidence === q.confidence);
    }
    if (q.search) {
      const needle = q.search.toLowerCase();
      groups = groups.filter(
        (g) => g.key.includes(needle)
          || g.members.some((m) => m.canonicalName.toLowerCase().includes(needle)),
      );
    }

    const total = groups.length;
    const limited = groups.slice(0, q.limit ?? 100);

    return {
      items: limited,
      total,
      hasMore: total > limited.length,
      // Hany jeloltsor esne ki osszesen, ha minden javaslatot elfogadnank.
      // Ez a szam mondja meg, mennyit er a muvelet.
      redundant: groups.reduce((s, g) => s + g.members.length - 1, 0),
      counts: {
        high: groups.filter((g) => g.confidence === 'high').length,
        medium: groups.filter((g) => g.confidence === 'medium').length,
      },
    };
  });

  // ── Osszevonas ───────────────────────────────────────────────────────────
  //
  // A `keepId` TULEL, a `mergeIds` beleolvad. Minden idegen kulcsot atiranyi-
  // tunk, a beolvadt nevek pedig JOVAHAGYOTT aliasza valnak a tuleloen - ez
  // az igazi hozam: a kovetkezo kinyeres a "Sauska Brut" nevbol is a Sauska
  // boraszatot fogja felismerni.
  app.post('/producers/merge', async (req) => {
    const actor = requireAtLeast(req.user, 'catalog_manager');
    const body = z.object({
      keepId: z.string().uuid(),
      mergeIds: z.array(z.string().uuid()).min(1).max(50),
      /** A tulelo neve atirhato ugyanebben a lepesben. */
      canonicalName: z.string().min(2).max(200).optional(),
    }).parse(req.body ?? {});

    const mergeIds = [...new Set(body.mergeIds)].filter((id) => id !== body.keepId);
    if (!mergeIds.length) {
      throw new AppError('EMPTY_MERGE', 'Nincs mit osszevonni: a lista csak a tulelot tartalmazza.', 400);
    }

    const keep = await queryOne<{ id: string; canonical_name: string; status: string }>(
      `SELECT id::text, canonical_name, status FROM producers WHERE id = $1`, [body.keepId],
    );
    if (!keep) throw new AppError('NOT_FOUND', 'A megtartando boraszat nem talalhato.', 404);
    if (keep.status === 'merged') {
      throw new AppError(
        'KEEP_ALREADY_MERGED',
        'A megtartando boraszat maga is beolvadt egy masikba. Valaszd a vegso celt.',
        409,
      );
    }

    const sources = await query<{ id: string; canonical_name: string; status: string }>(
      `SELECT id::text, canonical_name, status FROM producers WHERE id = ANY($1::uuid[])`,
      [mergeIds],
    );
    if (sources.length !== mergeIds.length) {
      throw new AppError('NOT_FOUND', 'Az osszevonando boraszatok kozul nem mind talalhato.', 404);
    }
    const already = sources.filter((s) => s.status === 'merged');
    if (already.length) {
      throw new AppError(
        'ALREADY_MERGED',
        `Mar beolvadt boraszat: ${already.map((s) => s.canonical_name).join(', ')}.`,
        409,
      );
    }

    const moved = await transaction(async (client) => {
      // ── 1. Idegen kulcsok atiranyitasa ────────────────────────────────
      //
      // Negy tabla hivatkozik termelore. Ha barmelyik kimaradna, a beolvadt
      // sor `merged` allapotban is "hasznalatban" maradna, es a katalogus
      // egy resze egy lathatatlan termelore mutatna.
      const listings = await client.query(
        `UPDATE source_listings SET producer_id = $1 WHERE producer_id = ANY($2::uuid[])`,
        [body.keepId, mergeIds],
      );
      const families = await client.query(
        `UPDATE product_families SET producer_id = $1 WHERE producer_id = ANY($2::uuid[])`,
        [body.keepId, mergeIds],
      );
      const brands = await client.query(
        `UPDATE brands SET producer_id = $1 WHERE producer_id = ANY($2::uuid[])`,
        [body.keepId, mergeIds],
      );
      // A dulo egyedi indexe `(name_norm, producer_id)` - az atiranyitas
      // utkozhet, ha a tulelohoz mar tartozik azonos nevu dulo. Ilyenkor a
      // beolvado sort nem mozgatjuk: a tulelo sajatja marad az ervenyes.
      const vineyards = await client.query(
        `UPDATE vineyards v SET producer_id = $1
          WHERE v.producer_id = ANY($2::uuid[])
            AND NOT EXISTS (
              SELECT 1 FROM vineyards w
               WHERE w.producer_id = $1 AND w.name_norm = v.name_norm)`,
        [body.keepId, mergeIds],
      );

      // ── 2. A beolvadt nevek aliassa valnak ────────────────────────────
      //
      // Ez a lepes a muvelet ertelme. Enelkul az osszevonas csak takaritas
      // lenne: a kovetkezo banyaszat ujra eloallitana a "Sauska Brut"-ot,
      // es a kinyeres tovabbra sem ismerne fel benne a Sauska boraszatot.
      //
      // `approved = true`: az osszevonas MAGA az emberi dontes, kulon
      // jovahagyast nem kerunk ra megegyszer.
      for (const s of sources) {
        await client.query(
          `INSERT INTO aliases
             (alias_type, alias_text, target_kind, target_id, source,
              evidence, approved, approved_by, approved_at, proposed_by)
           VALUES ('producer', $1, 'producer', $2, 'manual',
                   $3::jsonb, true, $4, now(), $4)
           ON CONFLICT DO NOTHING`,
          [
            s.canonical_name, body.keepId,
            JSON.stringify([{ kind: 'producer_merge', from: s.id, at: new Date().toISOString() }]),
            actor.id,
          ],
        );
      }

      // A beolvadt sorok ALIASZAI is atkerulnek: egy korabban rogzitett
      // irasmod nem veszhet el azzal, hogy a celja beolvadt.
      await client.query(
        `UPDATE aliases SET target_id = $1
          WHERE alias_type = 'producer' AND target_kind = 'producer'
            AND target_id = ANY($2::uuid[])
            AND NOT EXISTS (
              SELECT 1 FROM aliases b
               WHERE b.alias_type = 'producer' AND b.target_kind = 'producer'
                 AND b.target_id = $1 AND b.alias_norm = aliases.alias_norm
                 AND coalesce(b.shop_id, '00000000-0000-0000-0000-000000000000'::uuid)
                     = coalesce(aliases.shop_id, '00000000-0000-0000-0000-000000000000'::uuid))`,
        [body.keepId, mergeIds],
      );

      // ── 3. A beolvadt sorok lezarasa ──────────────────────────────────
      //
      // Nem toroljuk oket: a `merged_into_id` lanca teszi visszakeresheto-
      // ve, hogy egy regi hivatkozas hova vezet. A reszleges egyedi index
      // (`WHERE status <> 'merged'`) ettol felszabadul, tehat a nev ujra
      // felvehetove valik, ha valaha kulon boraszat lesz belole.
      await client.query(
        `UPDATE producers
            SET status = 'merged', merged_into_id = $1,
                decided_by = $3, decided_at = now(),
                notes = coalesce(notes || E'\\n', '')
                        || 'Osszevonva ide: ' || $4
          WHERE id = ANY($2::uuid[])`,
        [body.keepId, mergeIds, actor.id, keep.canonical_name],
      );

      // ── 4. A tulelo ujra "meg nem alkalmazott" ────────────────────────
      //
      // Az uj aliaszok csak akkor hatnak a MAR begyujtott nevekre, ha egy
      // ujrakinyeres vegigmegy rajtuk. A varolista magaban az adatbazisban
      // van (`applied_at IS NULL`), nem a job payloadjaban - ezert eleg ezt
      // a mezot nullazni, es a szokasos `pendingOnly` futas elviszi.
      //
      // Ez fontosabb, mint amilyennek latszik: ha a payloadra bíznánk, a
      // kozos idempotencia-kulcs miatt egy MAR VARAKOZO futas elnyelne az
      // uj boraszatot, es az osszevonas csendben hatastalan maradna.
      await client.query(
        `UPDATE producers
            SET applied_at = NULL,
                canonical_name = coalesce($2, canonical_name)
          WHERE id = $1`,
        [body.keepId, body.canonicalName ?? null],
      );

      return {
        listings: listings.rowCount ?? 0,
        families: families.rowCount ?? 0,
        brands: brands.rowCount ?? 0,
        vineyards: vineyards.rowCount ?? 0,
      };
    });

    await audit({
      actorUserId: actor.id, action: 'producer.merged', entityType: 'producer',
      entityId: body.keepId,
      summary: `${sources.length} boraszat osszevonva ide: ${body.canonicalName ?? keep.canonical_name}`
        + ` (${sources.map((s) => s.canonical_name).join(', ')})`,
      correlationId: req.correlationId,
    });

    // Az osszevonas uj aliaszokat hozott letre - ezek CSAK egy ujrakinyeres
    // utan lepnek hatalyba a mar begyujtott neveken. Ugyanaz a kesleltetett,
    // kozos kulcsu futas, mint a jovahagyasnal: aki egymas utan von ossze tiz
    // csoportot, annak EGY futas dolgozza fel mind a tizet.
    const job = await enqueue({
      redisUrl: config.REDIS_URL,
      queue: 'product-ingest',
      name: 'reextract-listings',
      payload: { pendingOnly: true, actorUserId: actor.id },
      idempotencyKey: 'reextract-pending',
      priority: JOB_PRIORITY['product-ingest'] ?? 50,
      delayMs: 20_000,
      correlationId: req.correlationId,
    });

    return {
      ok: true,
      keepId: body.keepId,
      merged: sources.length,
      moved,
      apply: { jobId: job.jobId, deduped: job.deduped },
    };
  });
}
