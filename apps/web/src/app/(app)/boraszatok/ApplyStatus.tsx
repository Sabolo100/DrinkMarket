'use client';

/**
 * Az újrakinyerés állapota — a gombtól függetlenül.
 *
 * A gomb megnyomása után egy dőlt betűs üzenet jelent meg, de az a gomb saját
 * állapota volt: egy oldalváltás elmosta. A futás közben ment tovább, csak
 * semmi nem mondta meg. Egy húsz percig tartó műveletnél ez használhatatlan —
 * az ember nem tudja, várjon-e, vagy indítsa újra.
 *
 * Ez a sáv a `job_runs` naplóból olvas, tehát túléli az oldalváltást, a
 * frissítést és a böngésző bezárását is. Amíg fut, magától frissül; utána
 * megáll, és megmutatja az eredményt.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

interface Run {
  status: string;
  queuedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  errorMessage: string | null;
  full: boolean;
  result: {
    scanned?: number; changed?: number; unchanged?: number;
    withoutProducer?: number; queuedForClustering?: number;
    producersApplied?: number; skipped?: boolean; reason?: string;
  } | null;
}

interface Payload {
  state: 'never' | 'active' | 'succeeded' | 'failed' | 'dead_letter' | 'cancelled';
  run: Run | null;
}

/** Csak addig kérdezünk, amíg valóban történik valami. */
const POLL_MS = 5_000;

function elapsed(from: string, to: string | null): string {
  const start = new Date(from).getTime();
  const end = to ? new Date(to).getTime() : Date.now();
  const sec = Math.max(0, Math.round((end - start) / 1000));
  if (sec < 60) return `${sec} mp`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} perc`;
  return `${Math.floor(min / 60)} óra ${min % 60} perc`;
}

function num(v: number | undefined): string {
  return typeof v === 'number' ? v.toLocaleString('hu-HU') : '—';
}

export function ApplyStatus({ onFinished }: { onFinished?: () => void }) {
  const [data, setData] = useState<Payload | null>(null);
  const [, setTick] = useState(0);
  // Hogy a befejezésről pontosan EGYSZER szóljunk a szülőnek.
  const wasActive = useRef(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/v1/producers/apply/status', { cache: 'no-store' });
      if (!res.ok) return;
      const next = (await res.json()) as Payload;
      setData(next);
      if (wasActive.current && next.state !== 'active') {
        wasActive.current = false;
        onFinished?.();
      }
      if (next.state === 'active') wasActive.current = true;
    } catch {
      // A hálózat pillanatnyi hibája nem ok arra, hogy eldobjuk, amit tudunk.
    }
  }, [onFinished]);

  useEffect(() => { void load(); }, [load]);

  const active = data?.state === 'active';

  // Amíg fut: újrakérdezés. Emellett másodpercenként újrarajzolunk, hogy az
  // eltelt idő ne fagyjon be két lekérdezés között.
  useEffect(() => {
    if (!active) return undefined;
    const poll = setInterval(() => { void load(); }, POLL_MS);
    const clock = setInterval(() => setTick((t) => t + 1), 1_000);
    return () => { clearInterval(poll); clearInterval(clock); };
  }, [active, load]);

  if (!data || data.state === 'never' || !data.run) return null;

  const r = data.run;

  if (active) {
    const since = r.startedAt ?? r.queuedAt;
    return (
      <div className="callout" style={{ marginBottom: 16, borderLeft: '3px solid var(--verdigris)' }}>
        <div className="row-tight" style={{ gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
          <span
            aria-hidden
            style={{
              width: 8, height: 8, borderRadius: '50%',
              background: 'var(--verdigris)', flex: 'none',
            }}
          />
          <strong style={{ fontSize: 13 }}>
            {r.full ? 'Teljes újrakinyerés' : 'Újrakinyerés'} fut
          </strong>
          <span className="freshness">
            {r.startedAt ? `${elapsed(since, null)} óta` : 'sorban áll, még nem indult el'}
          </span>
        </div>
        <p style={{ margin: '6px 0 0', fontSize: 12 }}>
          A művelet a már begyűjtött terméknevekből dolgozik, és a katalógus méretétől
          függően <strong>percekig is eltarthat</strong>. Nyugodtan elnavigálhatsz — ez a sáv
          magától frissül, és a futást semmi nem szakítja meg. Újraindítani nem érdemes: a
          kérés ugyanahhoz a futáshoz csatlakozna.
        </p>
      </div>
    );
  }

  if (data.state === 'failed' || data.state === 'dead_letter') {
    return (
      <div className="callout" style={{ marginBottom: 16, borderLeft: '3px solid var(--rust)' }}>
        <p className="label" style={{ marginBottom: 4 }}>Az utolsó újrakinyerés elszállt</p>
        <p style={{ margin: 0, fontSize: 12 }}>
          {r.errorMessage ?? 'Ismeretlen hiba.'}
          {data.state === 'failed' && ' A rendszer még egyszer megpróbálja.'}
        </p>
      </div>
    );
  }

  // Sikeres futás. A számok mondják meg, ért-e valamit — egy „kész" felirat
  // önmagában nem válasz arra, hogy történt-e bármi.
  const res = r.result ?? {};
  if (res.skipped) {
    return (
      <div className="callout" style={{ marginBottom: 16 }}>
        <p className="label" style={{ marginBottom: 4 }}>Az újrakinyerés nem talált munkát</p>
        <p style={{ margin: 0, fontSize: 12 }}>
          {res.reason === 'no_active_producers'
            ? 'Egyetlen jóváhagyott borászat sincs — előbb jóvá kell hagyni legalább egyet.'
            : `Kihagyva: ${res.reason ?? 'ismeretlen ok'}.`}
        </p>
      </div>
    );
  }

  return (
    <div className="callout" style={{ marginBottom: 16 }}>
      <div className="row-tight" style={{ gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
        <strong style={{ fontSize: 13 }}>
          {r.full ? 'Teljes újrakinyerés' : 'Újrakinyerés'} kész
        </strong>
        <span className="freshness">
          {r.finishedAt ? `${elapsed(r.finishedAt, null)} óta` : ''}
          {r.durationMs ? ` · ${Math.round(r.durationMs / 1000)} mp alatt` : ''}
        </span>
      </div>
      <div className="row-tight" style={{ gap: 16, marginTop: 6, flexWrap: 'wrap', fontSize: 12 }}>
        <span>átnézve <strong className="num">{num(res.scanned)}</strong></span>
        <span>változott <strong className="num">{num(res.changed)}</strong></span>
        <span>változatlan <strong className="num">{num(res.unchanged)}</strong></span>
        <span>párosításra küldve <strong className="num">{num(res.queuedForClustering)}</strong></span>
      </div>
      {res.changed === 0 && (
        <p className="muted" style={{ margin: '6px 0 0', fontSize: 12 }}>
          Semmi nem változott. Ez akkor helyes, ha a katalógus már naprakész — ha viszont
          most bővült a szótár, érdemes megnézni, hogy a borászatok jóvá vannak-e hagyva.
        </p>
      )}
    </div>
  );
}
