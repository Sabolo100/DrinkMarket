import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { currentSession } from '@/lib/api';
import { LoginForm } from './LoginForm';

export const metadata: Metadata = { title: 'Belépés' };
export const dynamic = 'force-dynamic';

export default async function LoginPage() {
  const session = await currentSession();
  if (session) redirect('/');

  return (
    <div className="gate">
      {/* A nyitókép nem dekoráció: maga az ársáv-sín, a rendszer egyetlen
          vizuális gondolata, nagyban megrajzolva. */}
      <div className="gate-stage">
        <div className="row-tight" style={{ gap: 12 }}>
          <span className="mark" style={{ background: '#F3E7DC', color: '#521324' }} aria-hidden="true">R</span>
          <span className="wordmark" style={{ color: '#F3E7DC' }}>
            Ár-intelligencia
            <small style={{ color: 'rgba(243,231,220,0.55)' }}>Radovin · pincefőkönyv</small>
          </span>
        </div>

        <div style={{ maxWidth: 460, margin: '48px 0' }}>
          <h1 className="display" style={{ fontSize: 'clamp(34px, 4.6vw, 56px)', color: '#F6EFE6' }}>
            Ugyanaz a palack.<br />
            <em style={{ color: '#E5B75E', fontStyle: 'normal' }}>Bizonyítva.</em>
          </h1>
          <p style={{ marginTop: 20, fontSize: 15, lineHeight: 1.6, color: 'rgba(243,231,220,0.72)', maxWidth: '44ch' }}>
            A rendszer nem hasonló nevű termékeket keres, hanem bizonyítja, hogy két
            webshop ugyanazt az eladható változatot kínálja — évjárat, kiszerelés,
            kiadás és csomagolás szerint. Ahol nincs bizonyíték, ott tartózkodik.
          </p>
        </div>

        <StageRail />
      </div>

      <div className="gate-form">
        <LoginForm />
      </div>
    </div>
  );
}

/**
 * A nyitókép sín: egy valódi termék piaci szóródása, felirattal. Ugyanaz a
 * rajz, ami a mátrix minden sorában visszatér.
 */
function StageRail() {
  const stops = [
    { label: 'legolcsóbb', price: '11 490', left: 0, kind: 'min' as const },
    { label: '', price: '12 900', left: 26, kind: 'mid' as const },
    { label: 'medián', price: '13 490', left: 43, kind: 'median' as const },
    { label: '', price: '14 200', left: 61, kind: 'mid' as const },
    { label: 'legdrágább', price: '16 990', left: 100, kind: 'max' as const },
  ];
  return (
    <div>
      <div className="label" style={{ color: 'rgba(243,231,220,0.45)', marginBottom: 14 }}>
        Egy termékváltozat · öt webshop · egy sín
      </div>
      <div style={{ position: 'relative', height: 56 }} aria-hidden="true">
        <div style={{
          position: 'absolute', top: 22, left: 0, right: 0, height: 8,
          background: 'linear-gradient(90deg, rgba(111,175,139,0.42) 0%, rgba(243,231,220,0.14) 52%, rgba(222,116,88,0.42) 100%)',
          border: '1px solid rgba(243,231,220,0.22)', borderRadius: 1,
        }} />
        {stops.map((s, i) => (
          <div key={i} style={{ position: 'absolute', left: `${s.left}%`, top: 0 }}>
            <div style={{
              position: 'absolute', top: 14, left: 0,
              width: s.kind === 'median' ? 1 : s.kind === 'min' ? 3 : 2,
              height: s.kind === 'median' ? 24 : s.kind === 'min' ? 26 : 20,
              transform: 'translateX(-50%)',
              background: s.kind === 'min' ? '#6FAF8B'
                : s.kind === 'max' ? '#DE7458'
                  : s.kind === 'median' ? 'rgba(243,231,220,0.5)' : 'rgba(243,231,220,0.72)',
              borderRadius: 1,
            }} />
            <div className="num" style={{
              position: 'absolute', top: 44,
              transform: s.left === 0 ? 'none' : s.left === 100 ? 'translateX(-100%)' : 'translateX(-50%)',
              fontSize: 11, whiteSpace: 'nowrap',
              color: s.kind === 'min' ? '#6FAF8B' : s.kind === 'max' ? '#DE7458' : 'rgba(243,231,220,0.6)',
            }}>
              {s.price}
            </div>
            {s.label && (
              <div className="label" style={{
                position: 'absolute', top: -2, fontSize: 8,
                transform: s.left === 0 ? 'none' : s.left === 100 ? 'translateX(-100%)' : 'translateX(-50%)',
                color: 'rgba(243,231,220,0.4)', whiteSpace: 'nowrap',
              }}>
                {s.label}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
