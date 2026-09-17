'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

export interface AdminUser {
  id: string;
  email: string;
  display_name: string;
  role: Role;
  status: 'active' | 'invited' | 'suspended';
  last_login_at: string | null;
  created_at: string;
  invite_pending: boolean;
}

type Role = 'viewer' | 'reviewer' | 'catalog_manager' | 'source_manager' | 'admin';

const ROLES: Array<{ key: Role; label: string; hint: string }> = [
  { key: 'viewer', label: 'Megtekintő', hint: 'Mindent lát, de semmit nem módosít.' },
  { key: 'reviewer', label: 'Ellenőr', hint: 'Párosításokat bírál el.' },
  { key: 'catalog_manager', label: 'Katalóguskezelő', hint: 'Borászatokat hagy jóvá és von össze.' },
  { key: 'source_manager', label: 'Forráskezelő', hint: 'Webshopokat és crawl-futásokat kezel.' },
  { key: 'admin', label: 'Adminisztrátor', hint: 'Mindenhez hozzáfér, felhasználókat is kezel.' },
];

const roleLabel = (r: string) => ROLES.find((x) => x.key === r)?.label ?? r;

const STATUS: Record<AdminUser['status'], { label: string; chip: string }> = {
  active: { label: 'aktív', chip: 'chip-verified' },
  invited: { label: 'meghívva', chip: 'chip-review' },
  suspended: { label: 'felfüggesztve', chip: 'chip-rejected' },
};

interface Props {
  users: AdminUser[];
  csrfToken: string;
  selfId: string;
}

export function UserAdmin({ users, csrfToken, selfId }: Props) {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [role, setRole] = useState<Role>('viewer');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // A link CSAK most látszik: az API a tokent nem tárolja, később nem kérdezhető le.
  const [link, setLink] = useState<{ email: string; url: string } | null>(null);
  const [copied, setCopied] = useState(false);

  async function call(key: string, url: string, method: string, body?: unknown) {
    setBusy(key); setError(null);
    try {
      const res = await fetch(url, {
        method,
        headers: { 'content-type': 'application/json', 'x-csrf-token': csrfToken },
        // Torzs MINDIG kell: a Fastify 400-zal elutasitja az ures torzset, ha
        // a content-type application/json. Az "Uj meghivo link" gomb pont
        // torzs nelkul hivott - a valos API elleni proba fogta meg.
        body: JSON.stringify(body ?? {}),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setError(data?.error?.message ?? 'A művelet nem sikerült.');
        return null;
      }
      return data;
    } catch {
      setError('A kiszolgáló nem elérhető.');
      return null;
    } finally {
      setBusy(null);
    }
  }

  async function invite(e: React.FormEvent) {
    e.preventDefault();
    const data = await call('invite', '/api/v1/users/invite', 'POST', {
      email: email.trim(), displayName: name.trim(), role,
    });
    if (data?.inviteUrl) {
      setLink({ email: email.trim(), url: data.inviteUrl });
      setCopied(false);
      setEmail(''); setName(''); setRole('viewer');
      router.refresh();
    }
  }

  async function reinvite(u: AdminUser) {
    const data = await call(`reinvite-${u.id}`, `/api/v1/users/${u.id}/reinvite`, 'POST');
    if (data?.inviteUrl) {
      setLink({ email: u.email, url: data.inviteUrl });
      setCopied(false);
      router.refresh();
    }
  }

  async function changeRole(u: AdminUser, next: Role) {
    if (next === u.role) return;
    if (next === 'admin' && !confirm(`${u.display_name} adminisztrátor lesz, és felhasználókat is kezelhet. Biztos?`)) return;
    if (await call(`role-${u.id}`, `/api/v1/users/${u.id}/role`, 'PATCH', { role: next })) router.refresh();
  }

  async function setStatus(u: AdminUser, status: 'active' | 'suspended') {
    if (status === 'suspended'
      && !confirm(`${u.display_name} felfüggesztése: azonnal kilépteti minden eszközről. Folytatod?`)) return;
    if (await call(`status-${u.id}`, `/api/v1/users/${u.id}/status`, 'PATCH', { status })) router.refresh();
  }

  async function copy() {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link.url);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  const selectedHint = ROLES.find((r) => r.key === role)?.hint;

  return (
    <div className="stack-4">
      {/* ── Meghívás ─────────────────────────────────────────────────── */}
      <section className="callout" style={{ padding: 'var(--s-4)' }}>
        <p className="label" style={{ marginBottom: 10 }}>Új felhasználó meghívása</p>
        <form onSubmit={invite} className="row-tight" style={{ gap: 10, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <div className="field" style={{ minWidth: 220, flex: '1 1 220px' }}>
            <label className="label" htmlFor="inv-email">E-mail cím</label>
            <input id="inv-email" type="email" required value={email}
                   onChange={(e) => setEmail(e.target.value)} />
          </div>
          <div className="field" style={{ minWidth: 180, flex: '1 1 180px' }}>
            <label className="label" htmlFor="inv-name">Név</label>
            <input id="inv-name" required minLength={2} maxLength={120} value={name}
                   onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="field" style={{ minWidth: 170 }}>
            <label className="label" htmlFor="inv-role">Szerepkör</label>
            <select id="inv-role" value={role} onChange={(e) => setRole(e.target.value as Role)}>
              {ROLES.map((r) => <option key={r.key} value={r.key}>{r.label}</option>)}
            </select>
          </div>
          <button className="btn btn-primary" type="submit" disabled={busy === 'invite'}>
            {busy === 'invite' ? 'Meghívás…' : 'Meghívó link készítése'}
          </button>
        </form>
        {selectedHint && (
          <p className="freshness muted" style={{ margin: '8px 0 0' }}>{roleLabel(role)}: {selectedHint}</p>
        )}
      </section>

      {error && (
        <div className="callout callout-alert" role="alert">
          <strong>Nem sikerült.</strong> {error}
        </div>
      )}

      {/* ── A kész link — csak egyszer látszik ────────────────────────── */}
      {link && (
        <section className="callout" style={{ padding: 'var(--s-4)', borderColor: 'var(--brass)' }}>
          <p className="label" style={{ marginBottom: 6 }}>Meghívó link · {link.email}</p>
          <p style={{ margin: '0 0 10px', fontSize: 13 }}>
            Küldd el ezt a linket a meghívottnak. <strong>7 napig érvényes, egyszer használható</strong>,
            és <strong>most látod utoljára</strong> — a rendszer nem tárolja, később nem kérdezhető le.
            Ha elvész, a listában kérj újat.
          </p>
          <div className="row-tight" style={{ gap: 8, flexWrap: 'wrap' }}>
            <input readOnly value={link.url} aria-label="Meghívó link"
                   onFocus={(e) => e.currentTarget.select()}
                   style={{ flex: '1 1 380px', fontFamily: 'var(--font-mono, monospace)', fontSize: 12 }} />
            <button className="btn btn-sm" type="button" onClick={copy}>
              {copied ? 'Másolva ✓' : 'Másolás'}
            </button>
            <button className="btn btn-sm btn-ghost" type="button" onClick={() => setLink(null)}>
              Bezárás
            </button>
          </div>
        </section>
      )}

      {/* ── Felhasználók ─────────────────────────────────────────────── */}
      <div className="table-wrap">
        <table className="ledger">
          <thead>
            <tr>
              <th>Név</th>
              <th>E-mail</th>
              <th style={{ width: 190 }}>Szerepkör</th>
              <th style={{ width: 120 }}>Állapot</th>
              <th style={{ width: 140 }}>Utolsó belépés</th>
              <th style={{ width: 170 }}></th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => {
              const self = u.id === selfId;
              const st = STATUS[u.status] ?? STATUS.active;
              return (
                <tr key={u.id}>
                  <td>
                    <strong style={{ fontWeight: 500 }}>{u.display_name}</strong>
                    {self && <span className="freshness muted" style={{ marginLeft: 6 }}>(te)</span>}
                  </td>
                  <td className="muted">{u.email}</td>
                  <td>
                    {self ? (
                      <span>{roleLabel(u.role)}</span>
                    ) : (
                      <select value={u.role} disabled={busy !== null} aria-label={`${u.display_name} szerepköre`}
                              onChange={(e) => changeRole(u, e.target.value as Role)}>
                        {ROLES.map((r) => <option key={r.key} value={r.key}>{r.label}</option>)}
                      </select>
                    )}
                  </td>
                  <td><span className={`chip ${st.chip}`}>{st.label}</span></td>
                  <td className="freshness muted">
                    {u.last_login_at ? new Date(u.last_login_at).toLocaleString('hu-HU') : '—'}
                  </td>
                  <td className="right">
                    {!self && u.status === 'invited' && (
                      <button className="btn btn-sm btn-ghost" disabled={busy !== null}
                              title="Új, 7 napig érvényes link. A korábbi ezzel érvénytelenné válik."
                              onClick={() => reinvite(u)}>
                        Új meghívó link
                      </button>
                    )}
                    {!self && u.status === 'active' && (
                      <button className="btn btn-sm btn-ghost" disabled={busy !== null}
                              onClick={() => setStatus(u, 'suspended')}>
                        Felfüggesztés
                      </button>
                    )}
                    {!self && u.status === 'suspended' && (
                      <button className="btn btn-sm btn-ghost" disabled={busy !== null}
                              onClick={() => setStatus(u, 'active')}>
                        Újraaktiválás
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
