import Link from 'next/link';
import type { ReactNode } from 'react';
import type { SessionUser } from '@/lib/api';
import { NavLink } from './NavLink';
import { GlobalSearch } from './GlobalSearch';
import { AnchorShopPicker, type AnchorShop } from './AnchorShopPicker';
import { UserMenu } from './UserMenu';

interface Props {
  user: SessionUser;
  csrfToken: string;
  shops: AnchorShop[];
  counts: { reviews: number; unmatched: number; alerts: number; unclustered: number };
  children: ReactNode;
}

/**
 * A rendszer váza. A fejléc mindig hordozza a globális termékkeresőt és a
 * kiinduló webshop választót (spec 22.3) — a kettő együtt adja a
 * termékközpontú és a webshopközpontú nézet közti váltást.
 */
export function Shell({ user, csrfToken, shops, counts, children }: Props) {
  return (
    <div className="shell">
      <a className="skip-link" href="#tartalom">Ugrás a tartalomra</a>

      <header className="masthead">
        <Link href="/" style={{ display: 'flex', alignItems: 'center', gap: 10, textDecoration: 'none', color: 'inherit' }}>
          <span className="mark" aria-hidden="true">R</span>
          <span className="wordmark">
            Ár-intelligencia
            <small>Radovin · pincefőkönyv</small>
          </span>
        </Link>

        <GlobalSearch />
        <div className="spacer" />
        <AnchorShopPicker shops={shops} />
        <UserMenu user={user} csrfToken={csrfToken} />
      </header>

      <div className="body">
        <nav className="sidebar" aria-label="Fő navigáció">
          <div className="nav-group">
            <div className="label">Piac</div>
            <NavLink href="/">Ár-összehasonlítás</NavLink>
            <NavLink href="/termekek">Termékek</NavLink>
            <NavLink href="/arvaltozasok">Árváltozások</NavLink>
          </div>

          <div className="nav-group">
            <div className="label">Bizonyítás</div>
            <NavLink href="/parositas" count={counts.reviews} alert={counts.reviews > 0}>
              Párosítások ellenőrzése
            </NavLink>
            <NavLink href="/nem-talalt" count={counts.unmatched}>Nem talált termékek</NavLink>
            <NavLink href="/termektar" count={counts.unclustered}>Webshop-terméktár</NavLink>
            <NavLink href="/boraszatok">Borászatok</NavLink>
          </div>

          <div className="nav-group">
            <div className="label">Források</div>
            <NavLink href="/webshopok" count={counts.alerts} alert={counts.alerts > 0}>
              Webshopok és futások
            </NavLink>
            <NavLink href="/import">Import</NavLink>
          </div>

          <div className="nav-group">
            <div className="label">Rendszer</div>
            <NavLink href="/folyamatok">Folyamatkezelés</NavLink>
            <NavLink href="/beallitasok">Beállítások</NavLink>
            <NavLink href="/auditnaplo">Auditnapló</NavLink>
          </div>
        </nav>

        <main className="main" id="tartalom">{children}</main>
      </div>
    </div>
  );
}

export function PageHead({
  title, lede, actions,
}: { title: string; lede?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="page-head">
      <div>
        <h1 className="display">{title}</h1>
        {lede && <p className="lede">{lede}</p>}
      </div>
      {actions && <div className="row-tight">{actions}</div>}
    </div>
  );
}
