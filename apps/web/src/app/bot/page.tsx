import type { Metadata } from 'next';

/**
 * Publikus botismertető (/bot).
 *
 * Ez az egyetlen oldal a rendszerben, amely bejelentkezés nélkül elérhető, és
 * amelyet szándékosan indexelhetünk. A crawler minden kérésében szerepel a
 * user agent kontakt URL-je — ha az üzemeltető utánanéz, ide jut. Egy 404-es
 * kontakt URL aláásná a spec jogi keretét, ezért ez az oldal nem hívja az
 * API-t: akkor is kiszolgálható, ha a háttérrendszer áll.
 *
 * A megjelenített értékek környezeti változóból jönnek, ugyanazokkal az
 * alapértelmezésekkel, mint az api/worker configjában — így az oldal nem
 * tud elcsúszni attól, amit a crawler ténylegesen küld.
 */

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'RadovinPriceBot',
  description:
    'Mit gyűjt a RadovinPriceBot, milyen ütemben, mit nem tesz, és hogyan lehet kizárni.',
  // A root layout mindent noindex-re állít. Ez az egy oldal kivétel: azért
  // van, hogy megtalálható legyen.
  robots: { index: true, follow: true },
};

const UA =
  process.env.CRAWLER_USER_AGENT || 'RadovinPriceBot/2.1 (+https://drinkdeal.hu/bot)';
const CONTACT = process.env.CRAWLER_CONTACT_EMAIL || 'tech@drinkdeal.hu';
const TOKEN = UA.split('/')[0] || 'RadovinPriceBot';

export default function BotPage() {
  return (
    <main style={{ maxWidth: 760, margin: '0 auto', padding: 'var(--s-7) var(--s-5) var(--s-9)' }}>
      <div className="row-tight" style={{ gap: 12, marginBottom: 'var(--s-7)' }}>
        <span className="mark" aria-hidden="true">R</span>
        <span className="wordmark">
          {TOKEN}
          <small>Ár-intelligencia · drinkdeal.hu</small>
        </span>
      </div>

      <h1 className="display" style={{ fontSize: 'clamp(28px, 4vw, 42px)' }}>
        Ez a bot italwebshopok<br />nyilvános termékoldalait olvassa.
      </h1>

      <p style={{ marginTop: 'var(--s-4)', fontSize: 15, lineHeight: 1.65, color: 'var(--ink-2)', maxWidth: '58ch' }}>
        Árösszehasonlítást készítünk magyar bor- és töményital-webshopok között. Ehhez a
        nyilvánosan elérhető termékoldalak adatait olvassuk ki — ugyanazokat, amelyeket
        bárki lát a böngészőjében. Ha az oldaladon találkoztál ezzel a bottal, itt
        megtalálod, mit csinál, milyen ütemben, és hogyan tudod kizárni.
      </p>

      <hr className="divider" style={{ margin: 'var(--s-6) 0' }} />

      <h2 className="label label-strong">Azonosítás</h2>
      <div className="sheet sheet-pad" style={{ marginTop: 'var(--s-3)' }}>
        <dl className="kv">
          <dt>User agent</dt>
          <dd className="num" style={{ fontSize: 12, wordBreak: 'break-all' }}>{UA}</dd>
          <dt>Kapcsolat</dt>
          <dd><a href={`mailto:${CONTACT}`}>{CONTACT}</a></dd>
        </dl>
      </div>

      <h2 className="label label-strong" style={{ marginTop: 'var(--s-6)' }}>Mit olvas</h2>
      <ul style={{ marginTop: 'var(--s-3)', paddingLeft: '1.2em', fontSize: 14, lineHeight: 1.7, color: 'var(--ink-2)' }}>
        <li>Nyilvános <strong>sitemap</strong> és nyilvános termékoldalak.</li>
        <li>A termékoldalról: megnevezés, márka, évjárat, kiszerelés, csomagolás,
            cikkszám / EAN, elérhetőség és <strong>ár</strong> — jellemzően a
            szabványos JSON-LD vagy microdata jelölésből.</li>
        <li>Semmi mást. Nem gyűjtünk vásárlói adatot, értékelést, kommentet vagy
            bármilyen személyes adatot.</li>
      </ul>

      <h2 className="label label-strong" style={{ marginTop: 'var(--s-6)' }}>Milyen ütemben</h2>
      <div className="sheet sheet-pad" style={{ marginTop: 'var(--s-3)' }}>
        <dl className="kv">
          <dt>Kérésütem</dt>
          <dd>Forrásonként alapértelmezés szerint <strong>2 másodpercenként
            legfeljebb egy kérés</strong> (0,5 kérés/mp), legfeljebb 2 párhuzamos
            kapcsolattal.</dd>
          <dt>Napi keret</dt>
          <dd>Webshoponként legfeljebb 8000 kérés naponta. Érzékeny forrásnál
            ennél lassabb ütemet állítunk be.</dd>
          <dt>robots.txt</dt>
          <dd>Feldolgozzuk és betartjuk, az RFC 9309 szerint.</dd>
          <dt>Retry-After</dt>
          <dd>Tiszteletben tartjuk. 429 és 5xx válaszra exponenciális
            visszalépés, véletlen szórással; futásonként legfeljebb 3 újrapróbálkozás.</dd>
          <dt>Időkorlát</dt>
          <dd>Kérésenként 20 másodperc.</dd>
          <dt>Ütemezés</dt>
          <dd>Napi néhány futás. Nem böngészünk végtelenítve, és nem terheljük
            a keresőt vagy a kosarat.</dd>
        </dl>
      </div>

      <h2 className="label label-strong" style={{ marginTop: 'var(--s-6)' }}>Mit nem teszünk</h2>
      <div className="callout callout-good" style={{ marginTop: 'var(--s-3)', lineHeight: 1.65 }}>
        Nem kerüljük meg a CAPTCHA-t. Nem rotálunk proxyt védelemkikerülés céljából.
        Nem lépünk be, és nem gyűjtünk bejelentkezés mögötti adatot. Nem hozunk létre
        fiókot, nem töltünk ki űrlapot, nem teszünk semmit a kosárba, és nem indítunk
        megrendelést.
      </div>
      <p style={{ marginTop: 'var(--s-3)', fontSize: 13, lineHeight: 1.65, color: 'var(--ink-3)', maxWidth: '58ch' }}>
        Ha egy forrás blokkol minket, a rendszerben az „elzárva” állapotot kapja —
        és ez soha nem jelenik meg úgy, mintha a terméked nem létezne vagy nem lenne
        ára.
      </p>

      <h2 className="label label-strong" style={{ marginTop: 'var(--s-6)' }}>Hogyan zárhatod ki</h2>
      <p style={{ marginTop: 'var(--s-3)', fontSize: 14, lineHeight: 1.7, color: 'var(--ink-2)', maxWidth: '58ch' }}>
        Vedd fel ezt a <code className="num">robots.txt</code> fájlodba — a
        következő futásnál életbe lép, kérnünk sem kell hozzá semmit:
      </p>
      <pre className="sheet sheet-pad num" style={{
        marginTop: 'var(--s-3)', fontSize: 12, lineHeight: 1.7,
        overflowX: 'auto', whiteSpace: 'pre',
      }}>{`User-agent: ${TOKEN}
Disallow: /`}</pre>
      <p style={{ marginTop: 'var(--s-3)', fontSize: 14, lineHeight: 1.7, color: 'var(--ink-2)', maxWidth: '58ch' }}>
        Ha csak lassítani szeretnél, egy útvonalat kizárni, vagy bármilyen kérdésed
        van, írj a <a href={`mailto:${CONTACT}`}>{CONTACT}</a> címre. Kérésre
        teljesen kivesszük a webshopodat a felderítésből — indoklás nélkül is.
      </p>

      <hr className="divider" style={{ margin: 'var(--s-7) 0 var(--s-4)' }} />
      <p className="label" style={{ color: 'var(--ink-4)' }}>
        drinkdeal.hu · Ár-intelligencia
      </p>
    </main>
  );
}
