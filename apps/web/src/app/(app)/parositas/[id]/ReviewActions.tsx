'use client';

/**
 * Review műveletek (spec 24.3).
 *
 * Minden módosító kérés visz döntési megjegyzést, rekordverziót (optimistic
 * locking) és idempotency key-t. Az elutasításnál a reason code kötelező.
 */
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { huf } from '@/lib/format';

interface Candidate {
  id: string; name: string; shopName: string; price: number | null; url: string;
}

interface Props {
  caseId: string;
  rowVersion: number;
  csrfToken: string;
  canApprove: boolean;
  canEditCanonical: boolean;
  candidates: Candidate[];
  currentListingId: string | null;
}

const REJECT_REASONS = [
  { code: 'VINTAGE_MISMATCH', label: 'Eltérő évjárat' },
  { code: 'VOLUME_MISMATCH', label: 'Eltérő kiszerelés' },
  { code: 'PACKAGING_MISMATCH', label: 'Eltérő csomagolás (pl. díszdoboz)' },
  { code: 'EXPRESSION_MISMATCH', label: 'Eltérő tétel / expression' },
  { code: 'PRODUCER_MISMATCH', label: 'Eltérő termelő vagy márka' },
  { code: 'PACK_COUNT_MISMATCH', label: 'Eltérő darabszám / csomag' },
  { code: 'AGE_STATEMENT_MISMATCH', label: 'Eltérő korjelölés' },
  { code: 'EDITION_MISMATCH', label: 'Eltérő kiadás' },
  { code: 'WRONG_PLATFORM_VARIANT', label: 'Rossz platformvariáns' },
  { code: 'MANUAL_REJECTION', label: 'Egyéb — a megjegyzésben leírva' },
];

export function ReviewActions({
  caseId, rowVersion, csrfToken, canApprove, canEditCanonical, candidates, currentListingId,
}: Props) {
  const router = useRouter();
  const [note, setNote] = useState('');
  const [reasonCode, setReasonCode] = useState('VINTAGE_MISMATCH');
  const [selected, setSelected] = useState(currentListingId ?? '');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [urlToCheck, setUrlToCheck] = useState('');

  async function call(action: string, body: Record<string, unknown>, label: string) {
    setBusy(action); setError(null); setDone(null);
    try {
      const res = await fetch(`/api/v1/review-cases/${caseId}/${action}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-csrf-token': csrfToken,
          'x-idempotency-key': `${caseId}:${action}:${rowVersion}`,
        },
        body: JSON.stringify({ ...body, rowVersion }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setError(data?.error?.message ?? 'A művelet nem sikerült.');
        setBusy(null);
        return;
      }
      setDone(label);
      setTimeout(() => { router.push('/parositas'); router.refresh(); }, 700);
    } catch {
      setError('A kiszolgáló nem elérhető.');
      setBusy(null);
    }
  }

  async function checkUrl() {
    if (!urlToCheck.trim()) return;
    setBusy('url'); setError(null);
    try {
      const res = await fetch('/api/v1/source-listings/fetch-url', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-csrf-token': csrfToken },
        body: JSON.stringify({ url: urlToCheck.trim() }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) setError(data?.error?.message ?? 'Az URL nem ellenőrizhető.');
      else setDone('Az URL letöltése elindult. Frissítsd az oldalt pár másodperc múlva.');
    } catch {
      setError('A kiszolgáló nem elérhető.');
    }
    setBusy(null);
  }

  if (!canApprove) {
    return (
      <div className="callout">
        Megtekintői jogosultsággal az eset nem bírálható el. Az elbíráláshoz
        legalább <strong>ellenőr</strong> szerepkör szükséges.
      </div>
    );
  }

  return (
    <div className="sheet">
      <div className="sheet-head">
        <span className="label label-strong">Döntés</span>
        <span className="freshness">rekordverzió: {rowVersion}</span>
      </div>

      <div className="sheet-pad stack">
        {error && <div className="callout callout-alert" role="alert">{error}</div>}
        {done && <div className="callout callout-good" role="status">{done}</div>}

        {candidates.length > 1 && (
          <div className="field">
            <label className="label" htmlFor="candidate">Melyik jelöltet fogadod el?</label>
            <select id="candidate" value={selected} onChange={(e) => setSelected(e.target.value)}>
              {candidates.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.shopName} — {c.name}{c.price ? ` — ${huf(c.price)}` : ''}
                </option>
              ))}
            </select>
            <span className="faint" style={{ fontSize: 11 }}>
              A nem választott jelöltek negatív memóriába kerülnek: azonos forrásállapot
              mellett nem kerülnek újra a sorba.
            </span>
          </div>
        )}

        <div className="field">
          <label className="label" htmlFor="note">Döntési megjegyzés</label>
          <textarea id="note" rows={2} value={note} onChange={(e) => setNote(e.target.value)}
                    placeholder="Mi alapján döntöttél? Ez bekerül az auditnaplóba." />
        </div>

        <div className="row" style={{ gap: 10 }}>
          <button className="btn btn-approve" disabled={busy !== null}
                  onClick={() => call('approve',
                    selected ? { note, sourceListingId: selected } : { note },
                    'A párosítás jóváhagyva. Azonnali árfrissítés indult.')}>
            {busy === 'approve' ? 'Mentés…' : '✓ Jóváhagyom ezt a párt'}
          </button>

          <div className="row-tight" style={{ gap: 6 }}>
            <select value={reasonCode} onChange={(e) => setReasonCode(e.target.value)}
                    aria-label="Elutasítás indoka" style={{ width: 'auto', minWidth: 210 }}>
              {REJECT_REASONS.map((r) => <option key={r.code} value={r.code}>{r.label}</option>)}
            </select>
            <button className="btn btn-reject" disabled={busy !== null}
                    onClick={() => call('reject',
                      { note, reasonCode, ...(selected ? { sourceListingId: selected } : {}) },
                      'A pár elutasítva, és bekerült a negatív memóriába.')}>
              {busy === 'reject' ? 'Mentés…' : '× Elutasítom'}
            </button>
          </div>

          <div className="spacer" />

          <button className="btn" disabled={busy !== null}
                  onClick={() => {
                    if (!note.trim()) { setError('A „nincs megfelelő termék” döntéshez indoklás kell.'); return; }
                    call('mark-not-found', { note },
                      'Rögzítve: ebben a webshopban nincs megfelelő termék.');
                  }}>
            Nincs megfelelő termék ebben a webshopban
          </button>

          <button className="btn btn-ghost" disabled={busy !== null}
                  onClick={() => call('defer', { note, days: 7 }, 'Az eset 7 nappal elhalasztva.')}>
            Későbbre halasztás
          </button>

          {canEditCanonical && (
            <button className="btn btn-ghost" disabled={busy !== null}
                    onClick={() => call('promote-listing', { note },
                      'Új kanonikus változat készül ebből a listingből, és indul a keresés a többi webshopban.')}>
              Új kanonikus változat ebből a listingből
            </button>
          )}
        </div>

        <hr className="divider" />

        <div className="row" style={{ gap: 10, alignItems: 'flex-end' }}>
          <div className="field grow" style={{ flex: 1, minWidth: 260 }}>
            <label className="label" htmlFor="url">Konkrét URL ellenőrzése</label>
            <input id="url" type="url" value={urlToCheck}
                   onChange={(e) => setUrlToCheck(e.target.value)}
                   placeholder="https://…  (csak regisztrált webshop termékoldala)" />
          </div>
          <button className="btn" onClick={checkUrl} disabled={busy !== null || !urlToCheck.trim()}>
            {busy === 'url' ? 'Letöltés…' : 'Letöltés és kinyerés'}
          </button>
        </div>
        <p className="faint" style={{ fontSize: 11, margin: 0 }}>
          Biztonsági okból csak a rendszerben regisztrált webshopok hosztjai tölthetők le,
          és kizárólag http/https protokollon.
        </p>
      </div>
    </div>
  );
}
