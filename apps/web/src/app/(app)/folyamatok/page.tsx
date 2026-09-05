import { PageHead } from '@/components/Shell';
import { apiSafe, currentSession } from '@/lib/api';
import { OperationList, type Operation } from './OperationList';

export const dynamic = 'force-dynamic';

/**
 * Folyamatkezelés.
 *
 * A rendszeren futtatható műveletek eddig szétszórva léteztek — egy gomb a
 * Borászatok oldalon, egy másik a webshop lapján, a többi kizárólag a
 * konténer termináljában. Ami hiányzott, az nem a művelet volt, hanem a KÉP:
 * melyik mit csinál, mi után kell futtatni, és épp áll-e vagy fut.
 *
 * A gyakorlati következménye az volt, hogy a lánc közepéből kimaradt egy
 * lépés, és utána senki nem értette, miért nem változik semmi.
 */

interface Payload {
  items: Operation[];
  dueNow: number;
  canRun: boolean;
}

export default async function OperationsPage() {
  const [data, session] = await Promise.all([
    apiSafe<Payload>('/system/operations', { items: [], dueNow: 0, canRun: false }),
    currentSession(),
  ]);

  const needed = data.items.filter((i) => i.state === 'needed');
  const running = data.items.filter((i) => i.state === 'running');

  return (
    <>
      <PageHead
        title="Folyamatkezelés"
        lede="A rendszeren futtatható műveletek — sorrendben, azzal együtt, hogy melyiket mi után kell elindítani."
      />

      {running.length > 0 && (
        <div className="callout" style={{ marginBottom: 16, borderLeft: '3px solid var(--verdigris)' }}>
          <p className="label" style={{ marginBottom: 4 }}>
            {running.length} művelet fut most
          </p>
          <p style={{ margin: 0, fontSize: 12 }}>
            {running.map((r) => r.name).join(', ')}. Amíg dolgoznak, ez az oldal magától
            frissül. Újat indítani nem érdemes — a kérés ugyanahhoz a futáshoz csatlakozna.
          </p>
        </div>
      )}

      {needed.length > 0 && (
        <div className="callout" style={{ marginBottom: 16, borderLeft: '3px solid var(--rust)' }}>
          <p className="label" style={{ marginBottom: 4 }}>
            {needed.length} művelet vár futtatásra
          </p>
          <p style={{ margin: 0, fontSize: 12 }}>
            Ezeket <strong>fentről lefelé</strong> érdemes elindítani: a sorrend nem
            önkényes, az egyik kimenete a másik bemenete. Ha kihagysz egyet, a lánc
            megáll, de nem jelez hibát — egyszerűen nem változik semmi.
          </p>
        </div>
      )}

      <OperationList initial={data} csrfToken={session?.csrfToken ?? ''} />

      <div className="callout" style={{ marginTop: 'var(--s-5)' }}>
        <p className="label" style={{ marginBottom: 4 }}>Ami nem itt van</p>
        <p style={{ margin: 0, fontSize: 12 }}>
          A <strong>katalógus-felderítés</strong> és az <strong>árfrissítés</strong>{' '}
          webshoponként külön indul, mert mindegyik a saját bolt oldalát járja végig és a
          saját sebességkorlátjához igazodik. Azok a <strong>Webshopok és futások</strong>{' '}
          oldalon, boltonként érhetők el — ott látszik az utolsó futásuk eredménye is.
        </p>
      </div>

      <p className="muted" style={{ fontSize: 12, marginTop: 'var(--s-4)', maxWidth: '70ch' }}>
        A <strong>„futtatni kell"</strong> jelzés azt jelenti, hogy a műveletnek van
        tényleges munkája — nem azt, hogy baj van. Ami <strong>„rendben"</strong>, azt
        elindítani sem árt, de nem változtat semmin.
      </p>
    </>
  );
}
