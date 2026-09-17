'use client';

import type { RefObject } from 'react';

/**
 * A szerepkörök magyarázata — felugró ablakban.
 *
 * A tartalom NEM leírás arról, mit „kellene" tudnia egy szerepkörnek, hanem
 * arról, amit a rendszer TÉNYLEGESEN megenged. Az API minden végpontját
 * végignéztük: ez alapján dönt az admin arról, kinek mihez adjon hozzáférést,
 * ezért egy szépített táblázat rosszabb volna, mint ha nem lenne.
 *
 * Ezért látszik benne a Katalóguskezelő és a Forráskezelő közti eltérés is.
 * A két szerepkör neve más feladatot jelöl, és a felület a legtöbb helyen
 * ennek megfelelően mutatja a gombokat — de az API rang szerint véd, a két
 * rang pedig azonos (30). Amit a felület elrejt, azt a rendszer mégis engedi.
 */

type Cell = 'yes' | 'no' | 'unintended';

const ROLES = [
  { key: 'viewer', name: 'Megtekintő', short: 'Meg­tekintő', purpose: 'Aki a piacot figyeli. Lát, de nem dönt, és nem indít semmit.' },
  { key: 'reviewer', name: 'Ellenőr', short: 'Ellenőr', purpose: 'Aki a párosításokat bírálja el. A napi kézi munka nagy része ide tartozik.' },
  { key: 'catalog_manager', name: 'Katalóguskezelő', short: 'Katalógus­kezelő', purpose: 'Aki a törzsadatot gondozza: borászatokat, kanonikus termékeket, importot.' },
  { key: 'source_manager', name: 'Forráskezelő', short: 'Forrás­kezelő', purpose: 'Aki a webshopokat és a crawlert felügyeli: felderítés, árfrissítés, beállítások.' },
  { key: 'admin', name: 'Adminisztrátor', short: 'Adminisz­trátor', purpose: 'Mindenhez hozzáfér, és ő adja ki a hozzáférést másoknak.' },
] as const;

/** Oszlopsorrend: Megtekintő, Ellenőr, Katalóguskezelő, Forráskezelő, Admin. */
const CAPS: Array<{ label: string; detail: string; cells: [Cell, Cell, Cell, Cell, Cell] }> = [
  {
    label: 'Árak, termékek és webshopok megtekintése',
    detail: 'Ár-összehasonlítás, Termékek, Árváltozások, Webshop-terméktár, Nem talált termékek, párosítási esetek, riport-export.',
    cells: ['yes', 'yes', 'yes', 'yes', 'yes'],
  },
  {
    label: 'Párosítások elbírálása',
    detail: 'Jóváhagyás, elutasítás, jelölt kiválasztása, „nem található", elhalasztás, azonnali keresés egy termékre.',
    cells: ['no', 'yes', 'yes', 'yes', 'yes'],
  },
  {
    label: 'Riasztások megtekintése és nyugtázása',
    detail: 'A rendszer figyelmeztetései a hibás futásokról és a gyanús árakról.',
    cells: ['no', 'yes', 'yes', 'yes', 'yes'],
  },
  {
    label: 'Borászatok jóváhagyása és összevonása',
    detail: 'A borászatlista, jóváhagyás, elutasítás, visszavonás, összevonás.',
    cells: ['no', 'no', 'yes', 'unintended', 'yes'],
  },
  {
    label: 'Kanonikus termékek és termékimport',
    detail: 'Létrehozás, szerkesztés, összevonás, felfüggesztés, aliaszok, tömeges import.',
    cells: ['no', 'no', 'yes', 'unintended', 'yes'],
  },
  {
    label: 'Folyamatok indítása',
    detail: 'Folyamatkezelés: borászat-bányászat, újrakinyerés, söprés, újraértékelés, publikálás.',
    cells: ['no', 'no', 'yes', 'yes', 'yes'],
  },
  {
    label: 'Webshopok kezelése',
    detail: 'Webshop-beállítások, felderítés, árfrissítés és állapotellenőrzés indítása.',
    cells: ['no', 'no', 'unintended', 'yes', 'yes'],
  },
  {
    label: 'Rendszerbeállítások és auditnapló',
    detail: 'Például a párosítási küszöbök; az auditnapló; riasztások lezárása.',
    cells: ['no', 'no', 'unintended', 'yes', 'yes'],
  },
  {
    label: 'Felhasználók kezelése',
    detail: 'Meghívás, szerepkör módosítása, felfüggesztés.',
    cells: ['no', 'no', 'no', 'no', 'yes'],
  },
  {
    label: 'Funkciókapcsolók',
    detail: 'Például az automatikus jóváhagyás be- és kikapcsolása.',
    cells: ['no', 'no', 'no', 'no', 'yes'],
  },
];

function Mark({ cell }: { cell: Cell }) {
  if (cell === 'yes') {
    return <span aria-label="igen" style={{ color: 'var(--verdigris)', fontWeight: 600 }}>✓</span>;
  }
  if (cell === 'unintended') {
    return (
      <span aria-label="jelenleg igen, de nem ennek a szerepkörnek szánt"
            title="Jelenleg megteheti, bár nem ennek a szerepkörnek szánt feladat."
            style={{ color: 'var(--brass)', fontWeight: 600 }}>
        ✓*
      </span>
    );
  }
  return <span aria-label="nem" className="faint">—</span>;
}

/**
 * Megnyitas. Nem eleg a puszta showModal(): a bongeszo a bezaro gombra teszi
 * a fokuszt, es kozben lejjebb gorgeti az ablakot - elesben ~37 pixellel, ami
 * elrejtette a fejlec feliratat. Utana visszaallitjuk a tetejere.
 */
export function openRoleGuide(dialogRef: RefObject<HTMLDialogElement | null>) {
  const d = dialogRef.current;
  if (!d || d.open) return;
  d.showModal();
  d.scrollTop = 0;
}

export function RoleGuideDialog({ dialogRef }: { dialogRef: RefObject<HTMLDialogElement | null> }) {
  const close = () => dialogRef.current?.close();

  return (
    <dialog
      ref={dialogRef}
      className="role-guide"
      aria-labelledby="role-guide-title"
      // A háttérre kattintás bezár: ilyenkor maga a <dialog> a cél, nem a tartalma.
      onClick={(e) => { if (e.target === dialogRef.current) close(); }}
      // Az Esc-et KIFEJEZETTEN kezeljük. A natív <dialog> elvben magától
      // bezárul rá, de a próbánál egy Chromium-alapú böngészőben a billentyű
      // megérkezett, a bezárás mégsem történt meg. Ahol a natív út működik,
      // ott ez sem árt: a második close() már nem csinál semmit.
      onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); close(); } }}
    >
      <div style={{ padding: 'var(--s-5, 24px)' }}>
        <div className="row-tight" style={{ justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
          <div>
            <div className="label">Jogosultsági szintek</div>
            <h2 id="role-guide-title" className="display" style={{ fontSize: 24, margin: '4px 0 0' }}>
              Mit jelentenek a szerepkörök?
            </h2>
          </div>
          <button type="button" className="btn btn-sm btn-ghost" onClick={close} aria-label="Bezárás">
            ✕
          </button>
        </div>

        <p style={{ fontSize: 13, margin: '12px 0 16px', maxWidth: '70ch' }}>
          A szerepkörök egymásra épülnek: mindegyik megteheti mindazt, amit az előtte lévő,
          és még valamit. Érdemes a legkisebb elégséges szintet adni. Adminisztrátor csak az legyen,
          akinek felhasználókat is kezelnie kell.
        </p>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))', gap: 10, marginBottom: 18 }}>
          {ROLES.map((r) => (
            <div key={r.key} className="callout" style={{ padding: '10px 12px', margin: 0 }}>
              <strong style={{ fontSize: 13 }}>{r.name}</strong>
              <p style={{ margin: '4px 0 0', fontSize: 12 }}>{r.purpose}</p>
            </div>
          ))}
        </div>

        <div className="table-wrap">
          <table className="ledger">
            <thead>
              <tr>
                <th>Mit tehet</th>
                {ROLES.map((r) => (
                  <th key={r.key} title={r.name}
                      style={{ textAlign: 'center', hyphens: 'manual', minWidth: 64, verticalAlign: 'bottom',
                               // A .ledger fejlec alapbol nowrap - itt tordelni KELL.
                               whiteSpace: 'normal', padding: '9px 6px' }}>
                    {r.short}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {CAPS.map((c) => (
                <tr key={c.label}>
                  <td style={{ minWidth: 170 }}>
                    <div style={{ fontWeight: 500 }}>{c.label}</div>
                    <div className="cell-note">{c.detail}</div>
                  </td>
                  {c.cells.map((cell, i) => (
                    <td key={ROLES[i]!.key} style={{ textAlign: 'center' }}><Mark cell={cell} /></td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="callout" style={{ marginTop: 16, borderLeftColor: 'var(--brass)', background: 'var(--brass-tint)' }}>
          <p style={{ margin: 0, fontSize: 13 }}>
            <strong style={{ color: 'var(--brass)' }}>✓*</strong>{' '}
            <strong>A Katalóguskezelő és a Forráskezelő jogai jelenleg azonosak.</strong>{' '}
            A két név eltérő feladatkört jelöl, és a felület a legtöbb helyen ennek megfelelően mutatja
            a gombokat, a rendszer azonban mindkettőnek engedi a másik feladatait is. Ha a szétválasztás
            fontos, egyelőre ezzel számolj, amikor szerepkört adsz.
          </p>
        </div>

        <div className="row-tight" style={{ justifyContent: 'flex-end', marginTop: 16 }}>
          <button type="button" className="btn btn-sm" onClick={close}>Értem</button>
        </div>
      </div>
    </dialog>
  );
}
