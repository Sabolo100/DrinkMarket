'use client';

/**
 * „Ez a sor elavult" — figyelmeztetés a párosítási sor tetején.
 *
 * A javaslatok nem frissülnek maguktól attól, hogy közben jóváhagytál egy
 * borászatot vagy pontosabb lett egy besorolás. Egy már nyitott eset a saját
 * ütemezése szerint kerül újra sorra — `needs_review`-nál akár két hét múlva.
 *
 * Emiatt az történt, hogy valaki végigdolgozta a sort, és olyan javaslatokról
 * döntött, amiket a rendszer időközben magától is kizárt volna. Az itt
 * elvégzett munka egy része tehát fölösleges volt.
 *
 * Ez a sáv csak akkor jelenik meg, amikor ténylegesen történt valami: futott
 * egy újrakinyerés az utolsó újraértékelés óta.
 */
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';

interface Op {
  key: string;
  state: string;
  pending: number;
  why: string | null;
}

export function RecheckBar({ csrfToken }: { csrfToken: string }) {
  const router = useRouter();
  const [op, setOp] = useState<Op | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const res = await fetch('/api/v1/system/operations', { cache: 'no-store' });
        if (!res.ok) return;
        const data = (await res.json()) as { items: Op[] };
        const recheck = data.items.find((i) => i.key === 'recheck') ?? null;
        if (alive) setOp(recheck);
      } catch {
        // Nem baj: ez a sav kiegeszites, nem a fo tartalom.
      }
    })();
    return () => { alive = false; };
  }, []);

  if (!op || op.state !== 'needed') return null;

  async function run() {
    setBusy(true);
    try {
      const res = await fetch('/api/v1/system/operations/recheck/run', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-csrf-token': csrfToken },
        body: '{}',
      });
      const body = await res.json().catch(() => null);
      setMessage(res.ok
        ? `${(body?.broughtForward ?? 0).toLocaleString('hu-HU')} pár újraértékelése előrehozva. `
          + 'A sor a következő percekben fogyni kezd.'
        : (body?.error?.message ?? 'A művelet nem indult el.'));
      if (res.ok) setTimeout(() => router.refresh(), 2000);
    } catch {
      setMessage('A kiszolgáló nem elérhető.');
    }
    setBusy(false);
  }

  return (
    <div className="callout" style={{ marginBottom: 16, borderLeft: '3px solid var(--rust)' }}>
      <p className="label" style={{ marginBottom: 4 }}>Ez a sor részben elavult</p>
      <p style={{ margin: '0 0 8px', fontSize: 12 }}>
        Az újrakinyerés azóta lefutott, hogy utoljára újraértékelted a párosításokat.
        Emiatt a sorban olyan javaslatok is szerepelhetnek, amiket a rendszer magától is
        kizárna — például mert időközben jóváhagytál egy borászatot, vagy pontosabb lett
        a besorolás.{' '}
        <strong className="num">{op.pending.toLocaleString('hu-HU')}</strong> pár parkol,
        ami magától csak később kerülne sorra.
      </p>
      <div className="row-tight" style={{ gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <button className="btn btn-sm" disabled={busy} onClick={run}>
          {busy ? 'Előrehozás…' : 'Újraértékelés előrehozása'}
        </button>
        {message && <span className="freshness">{message}</span>}
        {!message && (
          <span className="freshness muted">
            Nem dönt semmiről — csak előbbre hozza a gép saját felülvizsgálatát.
          </span>
        )}
      </div>
    </div>
  );
}
