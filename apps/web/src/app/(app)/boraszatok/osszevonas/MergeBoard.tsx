'use client';

/**
 * Egy összevonási csoport kártyája.
 *
 * A döntés két része külön kattintás: MELYIK sor marad, és MELYEK olvadjanak
 * bele. Alapból minden tag be van jelölve, a rendszer által javasolt túlélő
 * kivételével — de a túlélő szabadon átváltható, és bármelyik tag kivehető a
 * csoportból, ha mégsem tartozik oda.
 *
 * Ez a szabadság nem kényelmi kérdés. A bányászat a vezető szó alapján
 * csoportosít, és a „Gere Attila" ↔ „Gere Zsolt" pár is így kerül egymás
 * mellé — pedig két külön pincészet. Egy mindent-vagy-semmit gomb ilyenkor
 * arra kényszerítene, hogy az egész csoportot eldobd.
 */
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import type { MergeGroup } from './page';

interface Props {
  group: MergeGroup;
  csrfToken: string;
  canDecide: boolean;
}

export function MergeGroupCard({ group, csrfToken, canDecide }: Props) {
  const router = useRouter();
  const [keepId, setKeepId] = useState(group.suggestedKeepId);
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(
    group.members.find((m) => m.id === group.suggestedKeepId)?.canonicalName ?? '',
  );

  const mergeIds = group.members
    .filter((m) => m.id !== keepId && !excluded.has(m.id))
    .map((m) => m.id);

  const movedListings = group.members
    .filter((m) => mergeIds.includes(m.id))
    .reduce((s, m) => s + m.linkedListings, 0);

  function toggleExcluded(id: string) {
    setExcluded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  function selectKeep(id: string) {
    setKeepId(id);
    setDraft(group.members.find((m) => m.id === id)?.canonicalName ?? '');
    // A tulelo sosem lehet egyszerre kizarva is - az ertelmetlen allapot.
    setExcluded((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  }

  async function merge() {
    if (!mergeIds.length) return;
    setBusy(true); setError(null); setMessage(null);
    try {
      const res = await fetch('/api/v1/producers/merge', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-csrf-token': csrfToken },
        body: JSON.stringify({
          keepId,
          mergeIds,
          ...(renaming && draft.trim() ? { canonicalName: draft.trim() } : {}),
        }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setError(data?.error?.message ?? 'Az összevonás nem sikerült.');
      } else {
        setMessage(
          `${data.merged} sor összevonva · ${data.moved?.listings ?? 0} termék átkerült`
          + ' · újrakinyerés indul',
        );
        setTimeout(() => router.refresh(), 1500);
      }
    } catch {
      setError('A kiszolgáló nem elérhető.');
    }
    setBusy(false);
  }

  return (
    <section className="callout" style={{ padding: 'var(--s-3)' }}>
      <header
        className="row-tight"
        style={{ justifyContent: 'space-between', marginBottom: 8, flexWrap: 'wrap', gap: 8 }}
      >
        <div className="row-tight" style={{ gap: 6 }}>
          <strong style={{ fontSize: 13 }}>{group.key}</strong>
          <span
            className={`chip ${group.confidence === 'high' ? 'chip-verified' : 'chip-review'}`}
            title={
              group.kind === 'prefix'
                ? 'Az egyik név a másik pontos eleje — a tévedés esélye kicsi.'
                : 'Csak a vezető szó közös. Ide esik a „Gere Attila" ↔ „Gere Zsolt" eset is.'
            }
          >
            {group.kind === 'prefix' ? 'ugyanaz a név bővebben' : 'közös vezető szó'}
          </span>
          <span className="freshness">{group.members.length} jelölt</span>
        </div>
        {message && <span className="freshness">{message}</span>}
        {error && <span className="freshness" style={{ color: 'var(--rust)' }}>{error}</span>}
      </header>

      {group.warnings.map((w) => (
        <p key={w} className="freshness" style={{ color: 'var(--rust)', margin: '0 0 8px' }}>
          {w}
        </p>
      ))}

      <div className="table-wrap">
        <table className="ledger">
          <thead>
            <tr>
              <th style={{ width: 90 }}>Megtart</th>
              <th>Név</th>
              <th style={{ width: 110 }}>Állapot</th>
              <th className="right" style={{ width: 90 }}>Termék</th>
              <th style={{ width: 110 }}>Kihagy</th>
            </tr>
          </thead>
          <tbody>
            {group.members.map((m) => {
              const isKeep = m.id === keepId;
              const isOut = excluded.has(m.id);
              return (
                <tr key={m.id} style={isOut ? { opacity: 0.45 } : undefined}>
                  <td>
                    <label className="row-tight" style={{ gap: 6, cursor: 'pointer' }}>
                      <input
                        type="radio"
                        name={`keep-${group.key}`}
                        checked={isKeep}
                        disabled={!canDecide || busy}
                        onChange={() => selectKeep(m.id)}
                      />
                      {isKeep && <span className="freshness">túlélő</span>}
                    </label>
                  </td>
                  <td>
                    {isKeep && renaming ? (
                      <input
                        className="field" value={draft} autoFocus
                        aria-label="A megtartott borászat neve"
                        onChange={(e) => setDraft(e.target.value)}
                        style={{ width: '100%', fontSize: 13 }}
                      />
                    ) : (
                      <span style={{ fontWeight: isKeep ? 600 : 400 }}>{m.canonicalName}</span>
                    )}
                    {(m.personName || m.fuzzyBlocked) && (
                      <span
                        className="chip chip-review" style={{ marginLeft: 6 }}
                        title="Vezetéknév + keresztnév minta. Két ilyen név gyakran két külön borászat."
                      >
                        személynév
                      </span>
                    )}
                  </td>
                  <td className="freshness muted">
                    {m.status === 'active' ? 'jóváhagyva' : 'jelölt'}
                  </td>
                  <td className="right num">{m.linkedListings || '—'}</td>
                  <td>
                    {!isKeep && (
                      <label className="row-tight freshness" style={{ gap: 6, cursor: 'pointer' }}>
                        <input
                          type="checkbox" checked={isOut}
                          disabled={!canDecide || busy}
                          onChange={() => toggleExcluded(m.id)}
                        />
                        <span title="Ez a sor nem ugyanaz a borászat — maradjon külön.">
                          nem ez
                        </span>
                      </label>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {canDecide && (
        <div className="row-tight" style={{ gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
          <button className="btn btn-sm" disabled={busy || !mergeIds.length} onClick={merge}>
            {busy ? 'Összevonás…' : `Összevonás (${mergeIds.length})`}
          </button>
          <button
            className="btn btn-sm btn-ghost" disabled={busy}
            onClick={() => setRenaming((v) => !v)}
            title="A bányászat n-gramból adja a nevet; itt javítható a helyes írásmód."
          >
            {renaming ? 'Mégsem' : 'Túlélő átnevezése'}
          </button>
          <span className="freshness muted">
            {mergeIds.length
              ? `${movedListings} termék kerül át a megtartott sorhoz`
              : 'Jelölj ki legalább egy beolvadó sort.'}
          </span>
        </div>
      )}
    </section>
  );
}
