'use client';

import Link from 'next/link';
import { useState } from 'react';

/** Az API is ennyit követel meg (acceptInviteSchema). */
const MIN_LENGTH = 12;

export function AcceptInviteForm({ token }: { token: string }) {
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  if (!token) {
    return (
      <div className="stack rise">
        <div>
          <div className="label">Meghívó</div>
          <h2 className="display" style={{ fontSize: 28, marginTop: 6 }}>Hiányzó meghívó</h2>
        </div>
        <div className="callout callout-alert" role="alert">
          A link nem tartalmaz meghívó azonosítót. Nyisd meg újra a kapott linket
          teljes egészében, vagy kérj újat az adminisztrátortól.
        </div>
      </div>
    );
  }

  if (done) {
    return (
      <div className="stack rise">
        <div>
          <div className="label">Kész</div>
          <h2 className="display" style={{ fontSize: 28, marginTop: 6 }}>A fiókod aktív</h2>
          <p className="muted" style={{ fontSize: 13, marginTop: 8 }}>
            Most már beléphetsz az e-mail címeddel és az imént választott jelszóval.
          </p>
        </div>
        <Link className="btn btn-primary" href="/belepes"
              style={{ width: '100%', padding: '10px 14px', textAlign: 'center' }}>
          Tovább a belépéshez
        </Link>
      </div>
    );
  }

  const tooShort = password.length > 0 && password.length < MIN_LENGTH;
  const mismatch = confirm.length > 0 && confirm !== password;
  const canSubmit = password.length >= MIN_LENGTH && confirm === password && !busy;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/v1/auth/accept-invite', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token, password }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setError(data?.error?.message ?? 'A meghívó elfogadása nem sikerült.');
        setBusy(false);
        return;
      }
      setDone(true);
    } catch {
      setError('A kiszolgáló nem elérhető. Próbáld újra.');
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="stack rise">
      <div>
        <div className="label">Meghívó elfogadása</div>
        <h2 className="display" style={{ fontSize: 28, marginTop: 6 }}>Jelszó beállítása</h2>
        <p className="muted" style={{ fontSize: 13, marginTop: 8 }}>
          Legalább {MIN_LENGTH} karakter. Egy hosszabb, több szóból álló jelmondat
          biztonságosabb, mint egy rövid, bonyolult jelszó.
        </p>
      </div>

      {error && (
        <div className="callout callout-alert" role="alert">
          <strong>Nem sikerült.</strong> {error}
          {/lejart|ervenytelen/i.test(error) && (
            <> Kérj új meghívót az adminisztrátortól.</>
          )}
        </div>
      )}

      <div className="field">
        <label className="label" htmlFor="password">Új jelszó</label>
        <input id="password" type="password" value={password} required autoFocus
               autoComplete="new-password" minLength={MIN_LENGTH}
               onChange={(e) => setPassword(e.target.value)} />
        {tooShort && (
          <span className="faint" style={{ fontSize: 11 }}>
            Még {MIN_LENGTH - password.length} karakter kell.
          </span>
        )}
      </div>

      <div className="field">
        <label className="label" htmlFor="confirm">Jelszó még egyszer</label>
        <input id="confirm" type="password" value={confirm} required
               autoComplete="new-password"
               onChange={(e) => setConfirm(e.target.value)} />
        {mismatch && (
          <span style={{ fontSize: 11, color: 'var(--rust)' }}>A két jelszó nem egyezik.</span>
        )}
      </div>

      <button className="btn btn-primary" type="submit" disabled={!canSubmit}
              style={{ width: '100%', padding: '10px 14px' }}>
        {busy ? 'Mentés…' : 'Fiók aktiválása'}
      </button>
    </form>
  );
}
