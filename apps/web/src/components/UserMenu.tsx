'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import type { SessionUser } from '@/lib/api';

const ROLE_LABEL: Record<string, string> = {
  viewer: 'Megtekintő',
  reviewer: 'Ellenőr',
  catalog_manager: 'Katalóguskezelő',
  source_manager: 'Forráskezelő',
  admin: 'Adminisztrátor',
};

export function UserMenu({ user, csrfToken }: { user: SessionUser; csrfToken: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function logout() {
    setBusy(true);
    await fetch('/api/v1/auth/logout', {
      method: 'POST',
      headers: { 'x-csrf-token': csrfToken },
    });
    router.push('/belepes');
    router.refresh();
  }

  const initials = user.displayName
    .split(/\s+/).map((p) => p[0]).slice(0, 2).join('').toUpperCase();

  return (
    <div className="row-tight" style={{ gap: 10 }}>
      <div style={{ textAlign: 'right', lineHeight: 1.25 }}>
        <div style={{ fontSize: 12, fontWeight: 600 }}>{user.displayName}</div>
        <div className="label" style={{ fontSize: 9 }}>{ROLE_LABEL[user.role] ?? user.role}</div>
      </div>
      <div className="mark" style={{ background: 'var(--ink-2)', fontSize: 12 }} title={user.email}>
        {initials}
      </div>
      <button className="btn btn-ghost btn-sm" onClick={logout} disabled={busy}
              title="Kijelentkezés">
        {busy ? '…' : 'Kilépés'}
      </button>
    </div>
  );
}
