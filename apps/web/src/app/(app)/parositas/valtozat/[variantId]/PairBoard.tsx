'use client';

/**
 * A jelölt-kártyák és a kötegelt mentés.
 *
 * Három állapot kártyánként, alapból *függőben*. A mentés csak azt küldi el,
 * amiről ténylegesen döntöttél — ami függőben marad, az a sorban marad.
 * Ez fontos: egy félbehagyott képernyő nem veszíthet el munkát, és nem is
 * dönthet helyetted csendben.
 */
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { PairCase } from './page';

type Decision = 'pending' | 'accept' | 'reject';

interface CanonicalFacts {
  vintage: number | null;
  volumeMl: number | null;
  colour: string | null;
  grapes: string[];
  packCount: number | null;
  packagingType: string | null;
}

interface Props {
  cases: PairCase[];
  cheapest: number | null;
  canonical: CanonicalFacts;
  reasonLabels: Record<string, string>;
  csrfToken: string;
  canDecide: boolean;
}

/** Az elutasítás indoka — ugyanaz a lista, mint az egyeses felületen. */
const REJECT_REASON = 'MANUAL_REJECTION';

function ft(v: number | null | undefined): string {
  return typeof v === 'number' ? `${v.toLocaleString('hu-HU')} Ft` : '—';
}

/**
 * Csak azt mutatjuk, ami ELTÉR. A húsz soros mezőtábla, amiben tizennyolc sor
 * „nem bizonyított", zajt csinál — a döntéshez a különbség kell.
 */
function differences(c: PairCase, canon: CanonicalFacts): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  if (c.vintage_value !== null && canon.vintage !== null && c.vintage_value !== canon.vintage) {
    out.push(['évjárat', `${c.vintage_value} ↔ ${canon.vintage}`]);
  }
  if (c.volume_ml !== null && canon.volumeMl !== null && c.volume_ml !== canon.volumeMl) {
    out.push(['kiszerelés', `${c.volume_ml} ml ↔ ${canon.volumeMl} ml`]);
  }
  if (c.colour && canon.colour && c.colour !== canon.colour) {
    out.push(['szín', `${c.colour} ↔ ${canon.colour}`]);
  }
  const g = (c.grape_names ?? []).join(', ');
  const cg = canon.grapes.join(', ');
  if (g && cg && g !== cg) out.push(['fajta', `${g} ↔ ${cg}`]);
  if (c.pack_count !== null && canon.packCount !== null && c.pack_count !== canon.packCount) {
    out.push(['darabszám', `${c.pack_count} ↔ ${canon.packCount}`]);
  }
  if (c.packaging_type && canon.packagingType && c.packaging_type !== canon.packagingType) {
    out.push(['csomagolás', `${c.packaging_type} ↔ ${canon.packagingType}`]);
  }
  return out;
}

export function PairBoard({ cases, cheapest, canonical, reasonLabels, csrfToken, canDecide }: Props) {
  const router = useRouter();
  const [state, setState] = useState<Record<string, Decision>>({});
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});

  const set = useCallback((id: string, d: Decision) => {
    setState((s) => ({ ...s, [id]: s[id] === d ? 'pending' : d }));
  }, []);

  const decided = useMemo(
    () => cases.filter((c) => (state[c.id] ?? 'pending') !== 'pending'),
    [cases, state],
  );

  // Billentyuzet: a szamok valtjak a kartyakat, az `a` mindet elfogadja.
  // Ez teszi vegigjarhatova a sort - egerrel harom kattintas lenne kartyankent.
  useEffect(() => {
    if (!canDecide) return undefined;
    function onKey(e: KeyboardEvent) {
      const t = e.target as HTMLElement | null;
      if (t && ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName)) return;
      if (e.key >= '1' && e.key <= '9') {
        const idx = Number(e.key) - 1;
        const c = cases[idx];
        if (c) set(c.id, 'accept');
      } else if (e.key.toLowerCase() === 'a') {
        setState(Object.fromEntries(cases.map((c) => [c.id, 'accept' as Decision])));
      } else if (e.key === 'Escape') {
        setState({});
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [cases, set, canDecide]);

  async function save() {
    if (!decided.length) return;
    setBusy(true); setMessage(null); setErrors({});
    try {
      const res = await fetch('/api/v1/review-cases/bulk', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-csrf-token': csrfToken },
        body: JSON.stringify({
          decisions: decided.map((c) => ({
            caseId: c.id,
            action: state[c.id] === 'accept' ? 'approve' : 'reject',
            rowVersion: c.row_version,
            ...(state[c.id] === 'reject' ? { reasonCode: REJECT_REASON } : {}),
          })),
        }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setMessage(data?.error?.message ?? 'A mentés nem sikerült.');
      } else {
        const failed: Record<string, string> = {};
        for (const r of data.results ?? []) {
          if (!r.ok) failed[r.caseId] = r.message ?? r.error;
        }
        setErrors(failed);
        const n = Object.keys(failed).length;
        setMessage(n === 0
          ? `${data.applied} döntés mentve.`
          : `${data.applied} mentve, ${n} nem sikerült — töltsd újra az oldalt.`);
        // A termekenkenti nezetbe terunk vissza, nem a klasszikus listaba.
        // Aki ezt a nezetet valasztotta, azt akarja folytatni - egy dontes
        // utan visszadobni a masik nezetbe elveszi a valasztast.
        if (n === 0) setTimeout(() => router.push('/parositas/valtozatok'), 800);
        else router.refresh();
      }
    } catch {
      setMessage('A kiszolgáló nem elérhető.');
    }
    setBusy(false);
  }

  return (
    <>
      <div className="pair-cards">
        {cases.map((c, i) => {
          const d = state[c.id] ?? 'pending';
          const diffs = differences(c, canonical);
          const delta = cheapest && c.price_huf
            ? Math.round(((c.price_huf - cheapest) / cheapest) * 100)
            : null;

          return (
            <div key={c.id} className="pair-card" data-state={d}>
              <div className="pair-decide">
                <button
                  type="button" data-kind="accept" aria-pressed={d === 'accept'}
                  disabled={!canDecide} onClick={() => set(c.id, 'accept')}
                  title={`Elfogadom (${i + 1})`}
                >elfogadom</button>
                <button
                  type="button" data-kind="pending" aria-pressed={d === 'pending'}
                  disabled={!canDecide} onClick={() => set(c.id, 'pending')}
                >függőben</button>
                <button
                  type="button" data-kind="reject" aria-pressed={d === 'reject'}
                  disabled={!canDecide} onClick={() => set(c.id, 'reject')}
                >elutasítom</button>
              </div>

              <a
                className="pair-image" href={c.canonical_url ?? '#'}
                target="_blank" rel="noreferrer"
                title="Termékoldal megnyitása új lapon"
              >
                {c.image_url
                  ? <img src={c.image_url} alt={c.raw_name ?? ''} />
                  : <span className="no-image">nincs kép</span>}
              </a>

              <div className="pair-body">
                <div className="pair-shop">
                  <span
                    style={{
                      width: 8, height: 8, borderRadius: '50%',
                      background: c.brand_color ?? 'var(--cork)', flex: 'none',
                    }}
                  />
                  {c.shop_name ?? c.shop_key}
                </div>
                <div className="row-tight" style={{ justifyContent: 'space-between' }}>
                  <span className="pair-price">{ft(c.price_huf)}</span>
                  {delta !== null && delta !== 0 && (
                    <span className="freshness" style={{ color: delta > 0 ? 'var(--ink-4)' : 'var(--verdigris)' }}>
                      {delta > 0 ? '+' : ''}{delta}%
                    </span>
                  )}
                </div>
                <div className="pair-name">{c.raw_name}</div>

                {diffs.length > 0 && (
                  <div className="row-tight" style={{ gap: 4, flexWrap: 'wrap', marginTop: 2 }}>
                    {diffs.map(([k]) => (
                      <span key={k} className="chip chip-rejected">{k} eltér</span>
                    ))}
                  </div>
                )}
                {c.price_ratio !== null && c.price_ratio > 1.25 && (
                  <span className="chip chip-review" title="Az árak aránya kiugró — ezért nem hagyta jóvá a rendszer magától.">
                    {Number(c.price_ratio).toFixed(1)}x árarány
                  </span>
                )}
                {errors[c.id] && (
                  <span className="freshness" style={{ color: 'var(--rust)' }}>{errors[c.id]}</span>
                )}
              </div>

              <details className="pair-more">
                <summary>részletek</summary>
                <div className="pair-detail">
                  {diffs.length > 0 && (
                    <div className="pair-diff" style={{ marginBottom: 8 }}>
                      {diffs.map(([k, v]) => (
                        <div key={k} className="pair-diff-row">
                          <span className="k">{k}</span>
                          <span>{v}</span>
                        </div>
                      ))}
                    </div>
                  )}
                  <div className="pair-diff">
                    <div className="pair-diff-row">
                      <span className="k">évjárat</span><span className="num">{c.vintage_value ?? '—'}</span>
                    </div>
                    <div className="pair-diff-row">
                      <span className="k">kiszerelés</span>
                      <span className="num">{c.volume_ml ? `${c.volume_ml} ml` : '—'}</span>
                    </div>
                    <div className="pair-diff-row">
                      <span className="k">fajta</span>
                      <span>{(c.grape_names ?? []).join(', ') || '—'}</span>
                    </div>
                    <div className="pair-diff-row">
                      <span className="k">minőség</span>
                      <span className="num">{c.extraction_quality ?? '—'}</span>
                    </div>
                  </div>
                  {c.reason_codes?.length > 0 && (
                    <div style={{ marginTop: 8, color: 'var(--ink-3)' }}>
                      {c.reason_codes.map((r) => reasonLabels[r] ?? r).join('; ')}
                    </div>
                  )}
                </div>
              </details>
            </div>
          );
        })}
      </div>

      {canDecide && (
        <div className="pair-bar">
          <button className="btn btn-primary" disabled={busy || !decided.length} onClick={save}>
            {busy ? 'Mentés…' : `Mentés (${decided.length})`}
          </button>
          <button
            className="btn btn-sm btn-ghost" disabled={busy}
            onClick={() => setState(Object.fromEntries(cases.map((c) => [c.id, 'accept' as const])))}
          >
            Mind elfogadom
          </button>
          <button className="btn btn-sm btn-ghost" disabled={busy} onClick={() => setState({})}>
            Alaphelyzet
          </button>
          {message && <span className="freshness">{message}</span>}
          <span className="freshness" style={{ marginLeft: 'auto' }}>
            1-9 elfogad · A mind · Esc alaphelyzet
          </span>
        </div>
      )}
      {!canDecide && (
        <div className="callout" style={{ marginTop: 'var(--s-4)' }}>
          <p style={{ margin: 0 }}>Megtekintési jogosultsággal a döntés nem érhető el.</p>
        </div>
      )}
    </>
  );
}
