'use client';

/**
 * Borászat-jóváhagyás.
 *
 * A jelöltek a korpuszból bányászva, `proposed` állapotban keletkeznek —
 * élessé kizárólag itt, emberi döntéssel válnak (spec 8.10).
 *
 * A név szerkeszthető: a bányászat normalizált alakot ad ("chateau margaux"),
 * a helyes írásmódot a jóváhagyó állítja be.
 */
import { useRouter } from 'next/navigation';
import { useState } from 'react';

interface Props {
  id: string;
  name: string;
  personName: boolean;
  csrfToken: string;
}

export function ProducerActions({ id, name, personName, csrfToken }: Props) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name);
  const [fuzzyBlocked, setFuzzyBlocked] = useState(personName);

  async function post(path: string, body: unknown, key: string) {
    setBusy(key); setError(null);
    try {
      const res = await fetch(`/api/v1${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-csrf-token': csrfToken },
        body: JSON.stringify(body ?? {}),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        setError(data?.error?.message ?? 'A művelet nem sikerült.');
      } else {
        if (key === 'approve') setDone('jóváhagyva · újrakinyerés indul');
        router.refresh();
      }
    } catch {
      setError('A kiszolgáló nem elérhető.');
    }
    setBusy(null);
  }

  return (
    <div className="stack-2" style={{ minWidth: 230 }}>
      {error && <span className="freshness" style={{ color: 'var(--rust)' }}>{error}</span>}
      {done && <span className="freshness">{done}</span>}

      {editing ? (
        <input
          className="field" value={draft} autoFocus
          onChange={(e) => setDraft(e.target.value)}
          aria-label="Borászat neve"
          style={{ width: '100%', fontSize: 13 }}
        />
      ) : null}

      <label className="freshness" style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
        <input
          type="checkbox" checked={fuzzyBlocked}
          onChange={(e) => setFuzzyBlocked(e.target.checked)}
        />
        <span title="Személynév-alapú pincészetnél kötelező: a Gere Attila és a Gere Zsolt két külön borászat, a névhasonlóságuk viszont magas.">
          fuzzy egyezés tiltva
        </span>
      </label>

      <div className="row-tight" style={{ gap: 4 }}>
        <button
          className="btn btn-sm btn-approve" disabled={busy !== null}
          onClick={() => post(`/producers/${id}/approve`, {
            canonicalName: editing ? draft : undefined,
            fuzzyBlocked,
          }, 'approve')}
        >
          {busy === 'approve' ? '…' : 'Jóváhagyás'}
        </button>
        <button
          className="btn btn-sm btn-ghost" disabled={busy !== null}
          onClick={() => setEditing((v) => !v)}
          title="A bányászat normalizált nevet ad; itt javítható a helyes írásmód."
        >
          {editing ? 'Mégsem' : 'Átnevez'}
        </button>
        <button
          className="btn btn-sm btn-reject" disabled={busy !== null}
          onClick={() => post(`/producers/${id}/reject`, {}, 'reject')}
          title="Nem borászat. A sor megmarad, hogy egy későbbi bányászat ne javasolja újra."
        >
          {busy === 'reject' ? '…' : 'Elvet'}
        </button>
      </div>
    </div>
  );
}

/** A bányászat indítása és a küszöb állítása. */
export function MineButton({ csrfToken }: { csrfToken: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [minShops, setMinShops] = useState(2);

  async function run() {
    setBusy(true); setMessage(null);
    try {
      const res = await fetch('/api/v1/producers/mine', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-csrf-token': csrfToken },
        body: JSON.stringify({ minShops, limit: 400 }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) setMessage(data?.error?.message ?? 'A bányászat nem indult el.');
      else {
        setMessage(data?.state === 'active' ? 'Bányászat fut…' : 'Bányászat sorba állítva.');
        setTimeout(() => router.refresh(), 3000);
      }
    } catch {
      setMessage('A kiszolgáló nem elérhető.');
    }
    setBusy(false);
  }

  return (
    <div className="row-tight" style={{ gap: 8, alignItems: 'center' }}>
      {message && <span className="freshness">{message}</span>}
      <label className="freshness" title="Hány webshopban kell szerepelnie a névnek. A jelölős neveknél (Château, Pince) ez nem feltétel.">
        legalább{' '}
        <select
          className="field" value={minShops} style={{ padding: '2px 4px', fontSize: 12 }}
          onChange={(e) => setMinShops(Number(e.target.value))}
        >
          <option value={1}>1</option>
          <option value={2}>2</option>
          <option value={3}>3</option>
        </select>{' '}
        webshop
      </label>
      <button className="btn btn-sm" disabled={busy} onClick={run}>
        {busy ? '…' : 'Jelöltek frissítése'}
      </button>
    </div>
  );
}

/**
 * A jóváhagyások hatályba léptetése a már begyűjtött terméklistán.
 *
 * A jóváhagyás után ez magától elindul; a gomb a kézi ismétlésre van — ha a
 * futás megakadt, vagy ha közben bővült a fajta- és dűlőszótár, és emiatt
 * érdemes az egészet újra végigfuttatni.
 */
export function ApplyButton({ csrfToken, pending }: { csrfToken: string; pending: number }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  async function run(rebuildAll: boolean) {
    setBusy(rebuildAll ? 'all' : 'pending');
    setMessage(null);
    try {
      const res = await fetch('/api/v1/producers/apply', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-csrf-token': csrfToken },
        body: JSON.stringify({ rebuildAll }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) setMessage(data?.error?.message ?? 'Az újrakinyerés nem indult el.');
      else {
        setMessage(data?.deduped
          ? 'Már fut egy újrakinyerés — ez a kérés ahhoz csatlakozott.'
          : 'Újrakinyerés sorba állítva. A találatok pár perc múlva jelennek meg.');
        setTimeout(() => router.refresh(), 5000);
      }
    } catch {
      setMessage('A kiszolgáló nem elérhető.');
    }
    setBusy(null);
  }

  return (
    <div className="row-tight" style={{ gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
      <button className="btn btn-sm" disabled={busy !== null} onClick={() => run(false)}>
        {busy === 'pending' ? '…' : `Alkalmazás most (${pending})`}
      </button>
      <button
        className="btn btn-sm btn-ghost" disabled={busy !== null} onClick={() => run(true)}
        title="Minden jóváhagyott borászatra újra lefuttatja a névfelbontást. Akkor kell, ha bővült a fajta- vagy dűlőszótár."
      >
        {busy === 'all' ? '…' : 'Teljes újrakinyerés'}
      </button>
      {message && <span className="freshness">{message}</span>}
    </div>
  );
}

/**
 * Kereső a borászatlistához.
 *
 * A jelöltlista több száz soros, és pontszám szerint rendezve érkezik — ha egy
 * konkrét pincészetet keresel (Bock, Thummerer, Lisicza), a végiggörgetés nem
 * eszköz. A keresés a normalizált névre is illeszkedik, tehát az ékezet és a
 * kis-nagybetű nem számít: a „csanyi" megtalálja a „Csányi Pincészet"-et.
 */
export function ProducerSearch({
  initial, status, sort,
}: { initial: string; status: string; sort: string }) {
  const router = useRouter();
  const [value, setValue] = useState(initial);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const u = new URLSearchParams({ status, sort });
    if (value.trim()) u.set('search', value.trim());
    router.push(`/boraszatok?${u}`);
  }

  return (
    <form onSubmit={submit} className="row-tight" style={{ gap: 4 }}>
      <input
        className="field"
        value={value}
        placeholder="Keresés név szerint…"
        aria-label="Borászat keresése"
        onChange={(e) => setValue(e.target.value)}
        style={{ width: 190, fontSize: 12, padding: '4px 8px' }}
      />
      <button className="btn btn-sm" type="submit">Keresés</button>
      {initial && (
        <button
          type="button" className="btn btn-sm btn-ghost"
          onClick={() => { setValue(''); router.push(`/boraszatok?status=${status}&sort=${sort}`); }}
        >
          Törlés
        </button>
      )}
    </form>
  );
}
