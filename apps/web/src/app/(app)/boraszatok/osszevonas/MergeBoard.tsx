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

/** A tulelot kiveve minden sor ezek valamelyike. */
type MemberAction = 'keep' | 'merge' | 'discard' | 'skip';

/**
 * Mit mond a névben lévő TÖBBLET?
 *
 * Ez a különbség dönti el, hogy az összevonás hasznos-e vagy káros, és
 * eddig fejben kellett elvégezni. A „Takler Borbirtok" a pincészet neve; a
 * „Sauska Brut" a boré. Az elsőből hasznos aliasz lesz, a másodikból mérgező:
 * a szótár a `brut` szót termelőnévként nyelné el, és a pezsgő-felismerés
 * soha nem látná.
 */
const EXTRA_LABEL: Record<string, { text: string; chip: string; hint: string }> = {
  marker: {
    text: 'jelölő', chip: 'chip-verified',
    hint: 'A többlet a pincészet nevéhez tartozik (Pince, Borbirtok, Kft.).',
  },
  wine_term: {
    text: 'bor-szókincs', chip: 'chip-rejected',
    hint: 'A többlet a BORRA vonatkozik (Brut, Extra Dry, Puttonyos) — nem a pincészetre.',
  },
  other: {
    text: 'tételnév vagy dűlő', chip: 'chip-review',
    hint: 'A többlet nem borászatnév: valószínűleg dűlő (Szenta-hegyi) vagy tételnév (Primarius).',
  },
};

interface Props {
  group: MergeGroup;
  csrfToken: string;
  canDecide: boolean;
}

export function MergeGroupCard({ group, csrfToken, canDecide }: Props) {
  const router = useRouter();
  const [keepId, setKeepId] = useState(group.suggestedKeepId);
  // Soronkenti muvelet. Az alapertelmezes a rendszer javaslata - az mar
  // szetvalasztja a harom esetet, tehat a leggyakoribb esetben egy
  // kattintassal vegezhetsz.
  const [actions, setActions] = useState<Record<string, MemberAction>>(
    () => Object.fromEntries(
      group.members.map((m) => [m.id, m.suggestedAction === 'separate' ? 'skip' : m.suggestedAction]),
    ) as Record<string, MemberAction>,
  );
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(
    group.members.find((m) => m.id === group.suggestedKeepId)?.canonicalName ?? '',
  );

  const act = (id: string): MemberAction => (id === keepId ? 'keep' : actions[id] ?? 'skip');

  const mergeIds = group.members.filter((m) => act(m.id) === 'merge').map((m) => m.id);
  const discardIds = group.members.filter((m) => act(m.id) === 'discard').map((m) => m.id);

  const movedListings = group.members
    .filter((m) => mergeIds.includes(m.id))
    .reduce((s, m) => s + m.linkedListings, 0);

  // Hany nevbol lesz tenylegesen aliasz? Csak a jelolos nevekbol - a
  // bor-szokincsbol keszult aliasz elnyelne a termek azonositoit.
  const aliasCount = group.members
    .filter((m) => mergeIds.includes(m.id) && m.aliasUseful).length;

  function setAction(id: string, a: MemberAction) {
    setActions((prev) => ({ ...prev, [id]: a }));
  }

  function selectKeep(id: string) {
    setKeepId(id);
    setDraft(group.members.find((m) => m.id === id)?.canonicalName ?? '');
  }

  async function merge() {
    if (!mergeIds.length && !discardIds.length) return;
    setBusy(true); setError(null); setMessage(null);
    try {
      const res = await fetch('/api/v1/producers/merge', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-csrf-token': csrfToken },
        body: JSON.stringify({
          keepId,
          mergeIds,
          discardIds,
          ...(renaming && draft.trim() ? { canonicalName: draft.trim() } : {}),
        }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setError(data?.error?.message ?? 'Az összevonás nem sikerült.');
      } else {
        setMessage(
          `${data.merged} beolvasztva · ${data.discarded ?? 0} eldobva`
          + ` · ${data.moved?.listings ?? 0} termék átkerült`
          + ` · ${data.aliases ?? 0} aliasz · újrakinyerés indul`,
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
              <th className="right" style={{ width: 80 }}>Termék</th>
              <th style={{ width: 300 }}>Mi legyen vele</th>
            </tr>
          </thead>
          <tbody>
            {group.members.map((m) => {
              const isKeep = m.id === keepId;
              const a = act(m.id);
              return (
                <tr key={m.id} style={a === 'skip' ? { opacity: 0.5 } : undefined}>
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
                    {!isKeep && EXTRA_LABEL[m.extraKind] && (
                      <span
                        className={`chip ${EXTRA_LABEL[m.extraKind]!.chip}`}
                        style={{ marginLeft: 6 }}
                        title={EXTRA_LABEL[m.extraKind]!.hint}
                      >
                        {EXTRA_LABEL[m.extraKind]!.text}
                        {m.extraTokens.length ? `: ${m.extraTokens.join(' ')}` : ''}
                      </span>
                    )}
                  </td>
                  <td className="freshness muted">
                    {m.status === 'active' ? 'jóváhagyva' : 'jelölt'}
                  </td>
                  <td className="right num">{m.linkedListings || '—'}</td>
                  <td>
                    {!isKeep && (
                      <>
                        <div className="row-tight" style={{ gap: 4 }}>
                          {([
                            ['merge', 'beolvad', 'A termékei átkerülnek a megtartott sorhoz.'],
                            ['discard', 'elvet', 'Nem ez a borászat. A többletszó visszakerül a bor nevébe.'],
                            ['skip', 'marad', 'Külön borászat — érintetlenül hagyjuk.'],
                          ] as const).map(([value, label, hint]) => (
                            <button
                              key={value}
                              type="button"
                              className={`btn btn-sm${a === value ? '' : ' btn-ghost'}`}
                              disabled={!canDecide || busy
                                || (value === 'discard' && m.linkedListings > 0)}
                              title={value === 'discard' && m.linkedListings > 0
                                ? `${m.linkedListings} termék lóg rajta — azoknak előbb helyet kell találni.`
                                : hint}
                              onClick={() => setAction(m.id, value)}
                            >
                              {label}
                            </button>
                          ))}
                        </div>
                        <span className="freshness muted" style={{ display: 'block', marginTop: 4 }}>
                          {m.actionReason}
                        </span>
                      </>
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
          <button
            className="btn btn-sm"
            disabled={busy || (!mergeIds.length && !discardIds.length)}
            onClick={merge}
          >
            {busy ? 'Mentés…' : `Mentés · ${mergeIds.length} beolvad, ${discardIds.length} elvetve`}
          </button>
          <button
            className="btn btn-sm btn-ghost" disabled={busy}
            onClick={() => setRenaming((v) => !v)}
            title="A bányászat n-gramból adja a nevet; itt javítható a helyes írásmód."
          >
            {renaming ? 'Mégsem' : 'Túlélő átnevezése'}
          </button>
          <span className="freshness muted">
            {mergeIds.length || discardIds.length
              ? `${movedListings} termék kerül át a megtartott sorhoz`
                + `${aliasCount ? ` · ${aliasCount} névből lesz aliasz` : ' · aliasz nem keletkezik'}`
              : 'Válassz legalább egy sorhoz műveletet.'}
          </span>
        </div>
      )}
    </section>
  );
}
