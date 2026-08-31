'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';

export function NavLink({
  href, children, count, alert,
}: { href: string; children: ReactNode; count?: number; alert?: boolean }) {
  const pathname = usePathname();
  const active = href === '/' ? pathname === '/' : pathname.startsWith(href);
  return (
    <Link href={href} className="nav-item" aria-current={active ? 'page' : undefined}>
      <span>{children}</span>
      {count !== undefined && count > 0 && (
        <span className="count" data-alert={alert ? 'true' : undefined}>{count}</span>
      )}
    </Link>
  );
}
