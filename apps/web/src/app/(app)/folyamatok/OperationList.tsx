'use client';

/**
 * A rendszeren futtatható műveletek — sorrendben, állapottal, indítógombbal.
 *
 * A lista maga a magyarázat: minden sor megmondja, mit csinál a művelet, és
 * MI UTÁN kell futtatni. Ez utóbbi volt az, ami sehol nem volt leírva, és
 * emiatt maradt ki rendszeresen egy lépés a láncból — jellemzően a
 * párosítások újraértékelése az újrakinyerés után.
 *
 * A színkód nem dekoráció: a `needed` azt jelenti, hogy VAN mit csinálnia
 * most. Ami `ok`, azt nem érdemes elindítani.
 */
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';

export interface LastRun {
  status: string;
  queuedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  errorMessage: string | null;
  result: Record<string, unknown> | null;
}

export interface Operation {
  key: string;
  order: number;
  name: string;
  what: string;
  after: string;
  pending: number;
  pendingLabel: string;
  state: 'running' | 'failed' | 'needed' | 'ok' | 'never';
  why: string | null;
  lastRun: LastRun | null;
}

interface Payload {
  items: Operation[];
  dueNow: number;
  canRun: boolean;
}

const POLL_MS = 5_000;

const TONE: Record<Operation['state'], { label: string; colour: string; chip: string }> = {
  running: { label: 'fut', colour: 'var(--verdigris)', chip: 'chip-review' },
  needed: { label: 'futtatni kell', colour: 'var(--rust)', chip: 'chip-rejected' },
  failed: { label: 'elszállt', colour: 'var(--rust)', chip: 'chip-rejected' },
  ok: { label: 'rendben', colour: 'var(--verdigris)', chip: 'chip-verified' },
  never: { label: 'még nem futott', colour: 'var(--cork)', chip: 'chip-neutral' },
};

function ago(iso: string | null): string {
  if (!iso) return 'soha';
  const min = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  if (min < 1) return 'most';
  if (min < 60) return `${min} perce`;
  const h = Math.round(min / 60);
  if (h < 48) return `${h} órája`;
  return `${Math.round(h / 24)} napja`;
}

/** A futás eredményéből a néhány szám, ami tényleg mond valamit. */
function summarise(r: Record<string, unknown> | null): string | null {
  if (!r) return null;
  const n = (k: string) => (typeof r[k] === 'number' ? (r[k] as number).toLocaleString('hu-HU') : null);
  const parts: string[] = [];
  if (n('scanned')) parts.push(`átnézve ${n('scanned')}`);
  if (n('changed') !== null) parts.push(`változott ${n('changed')}`);
  if (n('written')) parts.push(`jelölt ${n('written')}`);
  if (n('queued')) parts.push(`sorba állítva ${n('queued')}`);
  if (n('remaining')) parts.push(`hátra ${n('remaining')}`);
  if (n('broughtForward') !== null) parts.push(`előrehozva ${n('broughtForward')}`);
  if (r['skipped']) parts.push(`kihagyva (${String(r['reason'] ?? 'ismeretlen')})`);
  return parts.length ? parts.join(' · ') : null;
}

export function OperationList({
  initial, csrfToken,
}: { initial: Payload; csrfToken: string }) {
  const router = useRouter();
  const [data, setData] = useState<Payload>(initial);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const wasRunning = useRef(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/v1/system/operations', { cache: 'no-store' });
      if (!res.ok) return;
      const next = (await res.json()) as Payload;
      setData(next);
      const running = next.items.some((i) => i.state === 'running');
      // Amikor az utolso futas is befejezodott, a mogottes oldalak szamlaloi
      // is elavultak - toltsuk ujra oket.
      if (wasRunning.current && !running) router.refresh();
      wasRunning.current = running;
    } catch {
      // Egy pillanatnyi halozati hiba nem ok arra, hogy eldobjuk, amit tudunk.
    }
  }, [router]);

  const anyRunning = data.items.some((i) => i.state === 'running');

  useEffect(() => {
    if (!anyRunning) return undefined;
    const t = setInterval(() => { void load(); }, POLL_MS);
    return () => clearInterval(t);
  }, [anyRunning, load]);

  async function run(key: string) {
    setBusy(key); setMessage(null);
    try {
      const res = await fetch(`/api/v1/system/operations/${key}/run`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-csrf-token': csrfToken },
        body: '{}',
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        setMessage(body?.error?.message ?? 'A művelet nem indult el.');
      } else if (body?.immediate) {
        setMessage(`${(body.broughtForward ?? 0).toLocaleString('hu-HU')} pár újraértékelése előrehozva. `
          + 'A feldolgozást a scheduler végzi, kötegenként.');
      } else {
        setMessage(body?.deduped
          ? 'Már fut egy ilyen művelet — ez a kérés ahhoz csatlakozott.'
          : 'Sorba állítva.');
      }
      await load();
    } catch {
      setMessage('A kiszolgáló nem elérhető.');
    }
    setBusy(null);
  }

  return (
    <>
      {message && (
        <div className="callout" style={{ marginBottom: 16 }}>
          <p style={{ margin: 0 }}>{message}</p>
        </div>
      )}

      <div className="stack-4">
        {data.items.map((op) => {
          const tone = TONE[op.state];
          const summary = summarise(op.lastRun?.result ?? null);
          return (
            <section
              key={op.key}
              className="callout"
              style={{ padding: 'var(--s-3)', borderLeft: `3px solid ${tone.colour}` }}
            >
              <header
                className="row-tight"
                style={{ justifyContent: 'space-between', gap: 8, flexWrap: 'wrap', marginBottom: 6 }}
              >
                <div className="row-tight" style={{ gap: 8, alignItems: 'baseline' }}>
                  <span className="num faint">{op.order}.</span>
                  <strong style={{ fontSize: 13 }}>{op.name}</strong>
                  <span className={`chip ${tone.chip}`}>{tone.label}</span>
                </div>
                {data.canRun && (
                  <button
                    className={`btn btn-sm${op.state === 'needed' ? '' : ' btn-ghost'}`}
                    disabled={busy !== null || op.state === 'running'}
                    onClick={() => run(op.key)}
                  >
                    {busy === op.key ? '…' : op.state === 'running' ? 'fut…' : 'Indítás'}
                  </button>
                )}
              </header>

              <p style={{ margin: '0 0 6px', fontSize: 12 }}>{op.what}</p>

              <p style={{ margin: '0 0 8px', fontSize: 12, color: 'var(--ink-3)' }}>
                <strong>Mikor kell:</strong> {op.after}
              </p>

              {op.why && (
                <p style={{ margin: '0 0 8px', fontSize: 12, color: 'var(--rust)' }}>{op.why}</p>
              )}

              <div
                className="row-tight"
                style={{ gap: 16, flexWrap: 'wrap', fontSize: 11, color: 'var(--ink-3)' }}
              >
                <span>
                  <strong className="num">{op.pending.toLocaleString('hu-HU')}</strong>
                  {' '}{op.pendingLabel}
                </span>
                <span>
                  utoljára: {ago(op.lastRun?.finishedAt ?? op.lastRun?.queuedAt ?? null)}
                  {op.lastRun?.durationMs
                    ? ` · ${Math.round(op.lastRun.durationMs / 1000)} mp`
                    : ''}
                </span>
                {summary && <span>{summary}</span>}
                {op.lastRun?.errorMessage && (
                  <span style={{ color: 'var(--rust)' }}>{op.lastRun.errorMessage.slice(0, 120)}</span>
                )}
              </div>
            </section>
          );
        })}
      </div>
    </>
  );
}
