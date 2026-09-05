/**
 * Folyamatkezelés: a rendszeren futtatható műveletek egy helyen.
 *
 * Ezek a műveletek eddig szétszórva léteztek — egy gomb a Borászatok oldalon,
 * egy másik a webshop lapján, a többi kizárólag a konténer termináljában. Ami
 * hiányzott, az nem a művelet volt, hanem a KÉP: melyik mit csinál, mi után
 * kell futtatni, milyen sorrendben, és épp áll-e vagy fut.
 *
 * A gyakorlati következménye az volt, hogy a lánc közepéből kimaradt egy
 * lépés, és utána senki nem értette, miért nem változik semmi. A leggyakoribb
 * eset: lefut az újrakinyerés, de a MÁR NYITOTT párosítási esetek nem
 * értékelődnek újra — azok a saját ütemezésük szerint 14 napig ülnek.
 *
 * Ezért a lista nem csak elindítani engedi a műveleteket, hanem meg is
 * mondja, melyikre VAN SZÜKSÉG most, és miért.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { execute, query, queryOne } from '@radovin/db';
import { AppError } from '@radovin/observability';
import type { AppConfig } from '../config.js';
import { requireAtLeast } from '../lib/auth.js';
import { audit } from '../lib/context.js';
import { enqueue, JOB_PRIORITY } from '../lib/queues.js';

/**
 * A művelet állapota. A sorrend nem esztétikai: ez dönti el, mit lát a
 * felhasználó pirosnak.
 *
 *   running  - épp dolgozik
 *   failed   - az utolsó futás elszállt
 *   needed   - VAN mit csinálnia, tehát érdemes elindítani
 *   ok       - nincs teendő
 *   never    - még soha nem futott
 */
type OpState = 'running' | 'failed' | 'needed' | 'ok' | 'never';

interface LastRun {
  status: string;
  queuedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  errorMessage: string | null;
  result: Record<string, unknown> | null;
}

/** Egy művelet leírása — ez a lista MAGA a dokumentáció. */
interface OpSpec {
  key: string;
  /** A lánc sorrendje. Az azonos számúak egymástól függetlenek. */
  order: number;
  name: string;
  /** Mit csinál — egy mondatban, a felhasználó nyelvén. */
  what: string;
  /** MI UTÁN kell futtatni. Ez az, ami eddig sehol nem volt leírva. */
  after: string;
  /** A `job_runs` sor, amiből az utolsó futás kiolvasható. */
  queue: string;
  jobName: string;
  /** Mi a mértékegysége annak, ami vár rá. */
  pendingLabel: string;
}

const OPS: OpSpec[] = [
  {
    key: 'mine',
    order: 1,
    name: 'Borászatjelöltek frissítése',
    what: 'A webshopok terméknevéből állít elő borászat-javaslatokat. '
      + 'Semmit nem hagy jóvá — csak felkínálja őket a Borászatok oldalon.',
    after: 'Új katalógus-felderítés után, amikor sok új termék került be.',
    queue: 'product-ingest',
    jobName: 'propose-producers',
    pendingLabel: 'új termék a legutóbbi bányászat óta',
  },
  {
    key: 'apply',
    order: 2,
    name: 'Újrakinyerés (teljes)',
    what: 'A már begyűjtött terméknevekből újra kiolvassa a borászatot, a '
      + 'szőlőfajtát, a bortípust és a besorolást. Nem jár újra a webshopokban.',
    after: 'Borászat jóváhagyása vagy összevonása után, illetve amikor bővült '
      + 'a fajta- és dűlőszótár.',
    queue: 'product-ingest',
    jobName: 'reextract-listings',
    pendingLabel: 'jóváhagyott borászat, ami még nem hatott a katalógusra',
  },
  {
    key: 'sweep',
    order: 3,
    name: 'Klaszterezési söprés',
    what: 'A még be nem sorolt termékeket beküldi a párosítási motorba. '
      + 'Kötegelt és folytatható — a scheduler magától is végzi.',
    after: 'Újrakinyerés után, vagy ha nagy a be nem sorolt hátralék.',
    queue: 'candidate-generation',
    jobName: 'cluster-sweep',
    pendingLabel: 'még be nem sorolt termék',
  },
  {
    key: 'recheck',
    order: 4,
    name: 'Párosítások újraértékelése',
    what: 'Előrehozza a parkoló változat–bolt párok újravizsgálatát. '
      + 'Ettől zárulnak le azok a javaslatok, amiket időközben kizárttá tett '
      + 'egy új borászat vagy egy pontosabb besorolás.',
    after: 'MINDEN újrakinyerés után. Enélkül a régi javaslatok a saját '
      + 'ütemezésük szerint akár két hétig is a sorban maradnak.',
    queue: 'maintenance',
    jobName: 'review-recheck',
    pendingLabel: 'parkoló pár, ami magától csak később kerülne sorra',
  },
  {
    key: 'publish',
    order: 5,
    name: 'Ár-összehasonlítás újraépítése',
    what: 'Újraszámolja a piaci oldalon látszó árakat és rangsorokat.',
    after: 'Párosítási döntések után. A scheduler óránként magától is futtatja.',
    queue: 'aggregate-dashboard',
    jobName: 'rebuild',
    pendingLabel: 'perce épült utoljára',
  },
];

/** Ezeket az állapotokat sosem hozzuk előre: emberi vagy lezárt döntés. */
const RECHECK_KEEP = ['auto_verified', 'human_verified', 'suspended'];

async function lastRunOf(queue: string, jobName: string): Promise<LastRun | null> {
  const r = await queryOne<{
    status: string; queued_at: Date; finished_at: Date | null;
    duration_ms: number | null; error_message: string | null;
    result: Record<string, unknown> | null;
  }>(
    `SELECT status, queued_at, finished_at, duration_ms, error_message, result
       FROM job_runs WHERE queue = $1 AND job_name = $2
      ORDER BY queued_at DESC LIMIT 1`,
    [queue, jobName],
  );
  if (!r) return null;
  return {
    status: r.status,
    queuedAt: r.queued_at.toISOString(),
    finishedAt: r.finished_at?.toISOString() ?? null,
    durationMs: r.duration_ms,
    errorMessage: r.error_message,
    result: r.result,
  };
}

export async function operationRoutes(app: FastifyInstance, config: AppConfig): Promise<void> {
  // ── A műveletek állapota ─────────────────────────────────────────────────
  app.get('/system/operations', async (req) => {
    requireAtLeast(req.user, 'viewer');

    const runs = new Map<string, LastRun | null>();
    for (const op of OPS) {
      runs.set(op.key, await lastRunOf(op.queue, op.jobName));
    }

    // Mennyi munka vár az egyes műveletekre.
    const counts = await queryOne<{
      pending_apply: number; unclustered: number; parked: number;
      due_now: number; publication_minutes: number | null;
    }>(
      `SELECT
         (SELECT count(*)::int FROM producers
           WHERE status = 'active' AND applied_at IS NULL)                    AS pending_apply,
         (SELECT count(*)::int FROM source_listings sl
            JOIN shops s ON s.id = sl.shop_id
           WHERE sl.listing_status = 'active' AND sl.cluster_status = 'unclustered'
             AND s.active AND NOT s.policy_disabled)                          AS unclustered,
         -- PARKOLO: nem igazolt par, aminek az ujravizsgalata a jovoben van.
         -- Ez az a halmaz, amit a "Parositasok ujraertekelese" elorehoz.
         (SELECT count(*)::int FROM variant_shop_status
           WHERE status <> ALL($1::text[]) AND next_search_at > now())        AS parked,
         (SELECT count(*)::int FROM variant_shop_status
           WHERE status <> ALL($1::text[])
             AND (next_search_at IS NULL OR next_search_at <= now()))         AS due_now,
         (SELECT (EXTRACT(EPOCH FROM (now() - max(published_at))) / 60)::int
            FROM market_publications WHERE status = 'published')              AS publication_minutes`,
      [RECHECK_KEEP],
    );

    // Hany uj termek jott be a legutobbi banyaszat ota?
    const mineRun = runs.get('mine');
    const newListings = await queryOne<{ count: number }>(
      `SELECT count(*)::int AS count
         FROM source_listings sl
         JOIN shops s ON s.id = sl.shop_id
        WHERE sl.listing_status = 'active'
          AND s.active AND NOT s.policy_disabled
          AND ($1::timestamptz IS NULL OR sl.first_seen_at > $1::timestamptz)`,
      [mineRun?.finishedAt ?? null],
    );

    // A `recheck` kulon eset: nem az a kerdes, van-e parkolo sor - hanem hogy
    // futott-e ujrakinyeres a legutobbi ujraertekeles OTA. Ez az a fuggoseg,
    // ami a gyakorlatban mindig kimaradt.
    const applyRun = runs.get('apply');
    const recheckRun = runs.get('recheck');
    const applyAfterRecheck = Boolean(
      applyRun?.finishedAt
      && (!recheckRun?.finishedAt || applyRun.finishedAt > recheckRun.finishedAt),
    );

    const pendingOf = (key: string): number => {
      switch (key) {
        case 'mine': return newListings?.count ?? 0;
        case 'apply': return counts?.pending_apply ?? 0;
        case 'sweep': return counts?.unclustered ?? 0;
        case 'recheck': return counts?.parked ?? 0;
        case 'publish': return counts?.publication_minutes ?? 0;
        default: return 0;
      }
    };

    const items = OPS.map((op) => {
      const last = runs.get(op.key) ?? null;
      const pending = pendingOf(op.key);

      let state: OpState;
      let why: string | null = null;

      // VAN-e munkaja? Ez a kerdes fuggetlen attol, hogy futott-e mar.
      //
      // Eloszor forditva volt: a "meg nem futott" ag ELOBB allt, es elnyomta
      // a "futtatni kell"-t. Igy egy friss rendszeren minden muvelet
      // szurkenek latszott, holott epp mindegyiknek lett volna dolga - es a
      // `recheck` fuggosegi szabalya, amiert az egesz keszult, sosem jutott
      // szohoz.
      let needs: boolean;
      if (op.key === 'recheck') {
        // Nem az a kerdes, van-e parkolo sor - hanem hogy tortent-e valami
        // AZOTA. Parkolo sor mindig van; ujrakinyeres nem mindig futott.
        needs = applyAfterRecheck && pending > 0;
        if (needs) why = 'Az újrakinyerés azóta lefutott, hogy utoljára újraértékeltél.';
      } else if (op.key === 'publish') {
        // Publikacio hianyaban a `pending` nulla - az viszont nem azt
        // jelenti, hogy naprakesz, hanem hogy meg soha nem epult fel.
        needs = !counts?.publication_minutes || counts.publication_minutes > 60;
      } else {
        needs = pending > 0;
      }

      if (last && (last.status === 'queued' || last.status === 'running')) {
        state = 'running';
      } else if (last && (last.status === 'failed' || last.status === 'dead_letter')) {
        state = 'failed';
        why = last.errorMessage;
      } else if (needs) {
        state = 'needed';
      } else if (!last) {
        state = 'never';
      } else {
        state = 'ok';
      }

      return {
        key: op.key, order: op.order, name: op.name,
        what: op.what, after: op.after,
        pending, pendingLabel: op.pendingLabel,
        state, why, lastRun: last,
      };
    });

    return {
      items,
      // A sorbol MOST esedekes - ez fut le magatol a kovetkezo korokben.
      dueNow: counts?.due_now ?? 0,
      canRun: ['catalog_manager', 'admin'].includes(req.user?.role ?? ''),
    };
  });

  // ── Indítás ──────────────────────────────────────────────────────────────
  app.post('/system/operations/:key/run', async (req) => {
    const actor = requireAtLeast(req.user, 'catalog_manager');
    const { key } = z.object({ key: z.string() }).parse(req.params);
    const op = OPS.find((o) => o.key === key);
    if (!op) throw new AppError('NOT_FOUND', 'Nincs ilyen muvelet.', 404);

    // A `recheck` nem job, hanem egyetlen UPDATE — azonnal lefut.
    //
    // Naplo-sort megis irunk rola, es ez nem konyveles: enelkul nem lehetne
    // megmondani, hogy futott-e MAR az ujrakinyeres ota. Eppen ez a fuggoseg
    // volt az, ami a gyakorlatban mindig kimaradt.
    if (key === 'recheck') {
      const started = Date.now();
      const updated = await execute(
        `UPDATE variant_shop_status
            SET next_search_at = now()
          WHERE status <> ALL($1::text[])
            AND (next_search_at IS NULL OR next_search_at > now())`,
        [RECHECK_KEEP],
      );
      await execute(
        `INSERT INTO job_runs (queue, job_name, status, payload, result,
                               queued_at, started_at, finished_at, duration_ms)
         VALUES ('maintenance','review-recheck','succeeded','{}'::jsonb,$1::jsonb,
                 now(), now(), now(), $2)`,
        [JSON.stringify({ broughtForward: updated }), Date.now() - started],
      ).catch(() => undefined);

      await audit({
        actorUserId: actor.id, action: 'operation.recheck', entityType: 'system',
        entityId: null,
        summary: `${updated} parositas ujraertekelese elorehozva`,
        correlationId: req.correlationId,
      });
      return { ok: true, key, broughtForward: updated, immediate: true };
    }

    const payloads: Record<string, { queue: string; name: string; payload: Record<string, unknown>; idem: string }> = {
      mine: {
        queue: 'product-ingest', name: 'propose-producers',
        payload: { minShops: 2, limit: 400, actorUserId: actor.id },
        idem: 'propose-producers',
      },
      apply: {
        queue: 'product-ingest', name: 'reextract-listings',
        payload: { all: true, actorUserId: actor.id },
        idem: 'reextract-all',
      },
      sweep: {
        queue: 'candidate-generation', name: 'cluster-sweep',
        payload: { limit: 300 },
        idem: 'cluster:sweep',
      },
      publish: {
        queue: 'aggregate-dashboard', name: 'rebuild',
        payload: { trigger: 'manual' },
        // Sajat kulcs, hogy egy futo utemezett job ne nyelje el a kezi kerest.
        idem: `aggregate:manual:${Math.floor(Date.now() / 30_000)}`,
      },
    };

    const spec = payloads[key];
    if (!spec) throw new AppError('NOT_RUNNABLE', 'Ez a muvelet nem inditható kezzel.', 400);

    const job = await enqueue({
      redisUrl: config.REDIS_URL,
      queue: spec.queue as never,
      name: spec.name,
      payload: spec.payload,
      idempotencyKey: spec.idem,
      priority: JOB_PRIORITY[spec.queue as never] ?? 50,
      correlationId: req.correlationId,
    });

    await audit({
      actorUserId: actor.id, action: `operation.${key}`, entityType: 'system',
      entityId: null, summary: `Muvelet inditva: ${op.name}`,
      correlationId: req.correlationId,
    });

    return { ok: true, key, jobId: job.jobId, deduped: job.deduped, state: job.state };
  });
}
