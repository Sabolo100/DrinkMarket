'use client';

/**
 * Kliensoldali műveletgombok. Minden módosító kérés CSRF tokent visz, és a
 * hosszú feladatok 202 + job ID választ kapnak (spec 21.7).
 */
import { useRouter } from 'next/navigation';
import { useState } from 'react';

/**
 * A beküldés visszajelzése.
 *
 * A felderítés sorát szándékosan két párhuzamos job dolgozza fel (a katalógus-
 * bejárás drága), ezért egy beküldött feladat simán várhat. Korábban minden
 * esetben az "elindult" üzenet jelent meg, a futás viszont csak akkor kap
 * `crawl_runs` sort, amikor ténylegesen elkezdődik — így úgy tűnt, hogy a
 * kérés nyom nélkül eltűnt.
 */
function queueMessage(label: string, data: unknown): string {
  const d = (data ?? {}) as { deduped?: boolean; state?: string; waiting?: number };
  const done = label.replace(/\.$/, '');

  if (d.state === 'active') return d.deduped ? `${done} — már fut` : `${done} — elindult`;

  // Várakozó sor: a saját feladatunk is beleszámít, ezért az "előtte" eggyel kevesebb.
  const ahead = Math.max(0, (d.waiting ?? 1) - 1);
  const sorban = ahead > 0
    ? `sorban áll (${ahead} feladat van előtte)`
    : 'sorban áll, hamarosan indul';
  return d.deduped ? `${done} — már ${sorban}` : `${done} — ${sorban}`;
}

function useAction(csrfToken: string) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function post(path: string, body: unknown, label: string, key: string) {
    setBusy(key); setError(null); setMessage(null);
    try {
      const res = await fetch(`/api/v1${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-csrf-token': csrfToken },
        body: JSON.stringify(body ?? {}),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) setError(data?.error?.message ?? 'A művelet nem sikerült.');
      else {
        setMessage(queueMessage(label, data));
        setTimeout(() => router.refresh(), 1200);
      }
    } catch {
      setError('A kiszolgáló nem elérhető.');
    }
    setBusy(null);
  }

  return { busy, message, error, post };
}

export function ShopActions({
  shopId, csrfToken, disabled,
}: { shopId: string; csrfToken: string; disabled?: boolean }) {
  const { busy, message, error, post } = useAction(csrfToken);

  return (
    <div className="row-tight" style={{ justifyContent: 'flex-end', gap: 4 }}>
      {(message || error) && (
        <span className="freshness" style={{ color: error ? 'var(--rust)' : 'var(--verdigris)' }}>
          {error ?? message}
        </span>
      )}
      <button className="btn btn-sm btn-ghost" disabled={busy !== null || disabled}
              title="Gyors elérhetőségi és kinyerési próba"
              onClick={() => post(`/shops/${shopId}/health-check`, {}, 'Health check', 'health')}>
        {busy === 'health' ? '…' : 'Teszt'}
      </button>
      <button className="btn btn-sm btn-ghost" disabled={busy !== null || disabled}
              title="Csak a már igazolt listingek árának frissítése"
              onClick={() => post(`/shops/${shopId}/price-refresh`, {}, 'Árfrissítés', 'refresh')}>
        {busy === 'refresh' ? '…' : 'Árfrissítés'}
      </button>
      <button className="btn btn-sm" disabled={busy !== null || disabled}
              title="Teljes katalógus felderítése"
              onClick={() => post(`/shops/${shopId}/discovery-runs`, {}, 'Felderítés', 'discovery')}>
        {busy === 'discovery' ? '…' : 'Felderítés'}
      </button>
    </div>
  );
}

export function SearchNowButton({
  productId, csrfToken, shopId,
}: { productId: string; csrfToken: string; shopId?: string }) {
  const { busy, message, error, post } = useAction(csrfToken);
  return (
    <>
      {(message || error) && (
        <span className="freshness" style={{ color: error ? 'var(--rust)' : 'var(--verdigris)', marginRight: 8 }}>
          {error ?? message}
        </span>
      )}
      <button className="btn btn-sm btn-primary" disabled={busy !== null}
              onClick={() => post(`/products/${productId}/search-now`,
                shopId ? { shopId } : {}, 'A keresés elindult minden aktív webshopban.', 'search')}>
        {busy === 'search' ? 'Indítás…' : 'Keresés újra'}
      </button>
    </>
  );
}

export function TrackToggle({
  productId, csrfToken, tracked,
}: { productId: string; csrfToken: string; tracked: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [on, setOn] = useState(tracked);

  async function toggle() {
    setBusy(true);
    const res = await fetch(`/api/v1/products/${productId}/track`, {
      method: on ? 'DELETE' : 'POST',
      headers: { 'content-type': 'application/json', 'x-csrf-token': csrfToken },
      body: on ? undefined : JSON.stringify({ priority: 100 }),
    });
    if (res.ok) { setOn(!on); router.refresh(); }
    setBusy(false);
  }

  return (
    <button className={`btn btn-sm ${on ? 'btn-primary' : ''}`} onClick={toggle} disabled={busy}
            title={on ? 'Eltávolítás a figyelőlistáról' : 'Kiemelt figyelés bekapcsolása'}>
      {busy ? '…' : on ? '★ Figyelt' : '☆ Figyelés'}
    </button>
  );
}

export function FlagToggle({
  flagKey, enabled, csrfToken, label, help, canEdit,
}: {
  flagKey: string; enabled: boolean; csrfToken: string;
  label: string; help?: string; canEdit: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [on, setOn] = useState(enabled);
  const [error, setError] = useState<string | null>(null);

  async function toggle() {
    setBusy(true); setError(null);
    const res = await fetch(`/api/v1/feature-flags/${flagKey}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'x-csrf-token': csrfToken },
      body: JSON.stringify({ enabled: !on }),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) setError(data?.error?.message ?? 'Nem sikerült.');
    else { setOn(!on); router.refresh(); }
    setBusy(false);
  }

  return (
    <div className="row" style={{ justifyContent: 'space-between', gap: 12,
                                  padding: '10px 0', borderBottom: '1px solid var(--rule-faint)' }}>
      <div style={{ maxWidth: '62ch' }}>
        <div style={{ fontWeight: 600, fontSize: 13 }}>{label}</div>
        {help && <div className="muted" style={{ fontSize: 12, marginTop: 2 }}>{help}</div>}
        {error && <div style={{ color: 'var(--rust)', fontSize: 12, marginTop: 4 }}>{error}</div>}
      </div>
      <button className={`btn btn-sm ${on ? 'btn-approve' : ''}`}
              onClick={toggle} disabled={busy || !canEdit}
              title={canEdit ? undefined : 'Ehhez adminisztrátori jogosultság szükséges.'}>
        {busy ? '…' : on ? '✓ Bekapcsolva' : 'Kikapcsolva'}
      </button>
    </div>
  );
}
