import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { currentSession } from '@/lib/api';
import { AcceptInviteForm } from './AcceptInviteForm';

export const metadata: Metadata = { title: 'Meghívó elfogadása' };
export const dynamic = 'force-dynamic';

/**
 * Meghívó elfogadása: itt állítja be a meghívott a SAJÁT jelszavát.
 *
 * Az admin soha nem ismeri és nem is továbbítja a jelszót — csak egy
 * egyszer használható, 7 napig élő linket küld. Ez az oldal korábban nem
 * létezett, így minden kiküldött meghívó 404-re futott.
 */
export default async function InvitePage({
  searchParams,
}: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  // Aki már be van lépve, annak nincs itt dolga.
  const session = await currentSession();
  if (session) redirect('/');

  const sp = await searchParams;
  const token = typeof sp['token'] === 'string' ? sp['token'] : '';

  return (
    <div className="gate">
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
            Meghívást kaptál.
          </h1>
          <p style={{ marginTop: 20, fontSize: 15, lineHeight: 1.6, color: 'rgba(243,231,220,0.72)', maxWidth: '44ch' }}>
            Válassz jelszót a fiókodhoz. A jelszót csak te ismered — a rendszer
            adminisztrátora sem látja, és nem is kérheti el.
          </p>
        </div>
      </div>

      <div className="gate-form">
        <AcceptInviteForm token={token} />
      </div>
    </div>
  );
}
