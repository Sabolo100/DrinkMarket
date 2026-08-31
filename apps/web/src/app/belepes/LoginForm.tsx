'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

export function LoginForm() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/v1/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setError(data?.error?.message ?? 'A belépés nem sikerült.');
        setBusy(false);
        return;
      }
      router.push('/');
      router.refresh();
    } catch {
      setError('A kiszolgáló nem elérhető. Próbáld újra.');
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="stack rise">
      <div>
        <div className="label">Belépés</div>
        <h2 className="display" style={{ fontSize: 28, marginTop: 6 }}>Meghívásos hozzáférés</h2>
        <p className="muted" style={{ fontSize: 13, marginTop: 8 }}>
          A rendszer zárt. Nyilvános regisztráció nincs; a hozzáférést
          adminisztrátor adja ki.
        </p>
      </div>

      {error && (
        <div className="callout callout-alert" role="alert">
          <strong>Nem sikerült a belépés.</strong> {error}
        </div>
      )}

      <div className="field">
        <label className="label" htmlFor="email">E-mail cím</label>
        <input id="email" type="email" value={email} required autoFocus
               autoComplete="username"
               onChange={(e) => setEmail(e.target.value)} />
      </div>

      <div className="field">
        <label className="label" htmlFor="password">Jelszó</label>
        <input id="password" type="password" value={password} required
               autoComplete="current-password"
               onChange={(e) => setPassword(e.target.value)} />
      </div>

      <button className="btn btn-primary" type="submit" disabled={busy}
              style={{ width: '100%', padding: '10px 14px' }}>
        {busy ? 'Belépés…' : 'Belépés'}
      </button>

      <p className="faint" style={{ fontSize: 11, lineHeight: 1.5 }}>
        A munkamenet szerveroldali, a süti HttpOnly és Secure. Minden módosító
        művelet szerepkör-ellenőrzött és auditált.
      </p>
    </form>
  );
}
