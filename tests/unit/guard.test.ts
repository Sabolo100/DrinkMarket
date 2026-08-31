/**
 * Válaszminőség-ellenőrzés (spec 11.4).
 *
 * A HTTP 200 önmagában NEM jelenti, hogy a crawl sikeres volt — de a
 * fordítottja is igaz: egy egészséges forrást SOHA nem szabad tévesen
 * blokkoltnak jelenteni, mert az megakadályozza az üzleti következtetést
 * és felesleges riasztást generál (spec 38/10).
 */
import { describe, it, expect } from 'vitest';
import { evaluateResponse, isPrivateAddress } from '@radovin/crawler-core';

const shopPage = (extra = '') => `<!doctype html><html><head>
<title>Bortársaság — Minőségi borok</title>
<script type="application/ld+json">{"@type":"Product","name":"Gere Róka Pinot Noir 2023",
"offers":{"@type":"Offer","price":11490,"priceCurrency":"HUF"}}</script>
${extra}</head><body>
<h1>Gere Attila Róka Pinot Noir 2023</h1>
<p>Villányi vörösbor, 0,75 liter, 13,5% alkoholtartalom. A Róka dűlő pinot noir
ültetvényéről származó tétel, barrique hordós érleléssel. Kiszerelés: palack.
Ár: 11 490 Ft. Készleten. Szállítás 2 munkanapon belül. Kóstolójegyzet:
meggyes, füstös, hosszú lecsengésű bor, amely jól párosítható vadhúsokhoz.</p>
<div class="price">11 490 Ft</div><button>Kosárba</button>
</body></html>`;

describe('challenge-felismerés — egészséges oldal nem lehet blokkolt', () => {
  it('normál termékoldalt átenged', () => {
    const v = evaluateResponse({ status: 200, body: shopPage(), contentType: 'text/html', url: 'https://x.hu/p/1' });
    expect(v.blocked).toBe(false);
    expect(v.reason).toBe('ok');
  });

  it('NEM blokkol csak azért, mert reCAPTCHA script van a kapcsolati űrlaphoz', () => {
    const v = evaluateResponse({
      status: 200,
      body: shopPage('<script src="https://www.google.com/recaptcha/api.js"></script>'),
      contentType: 'text/html', url: 'https://x.hu/p/1',
    });
    expect(v.blocked).toBe(false);
  });

  it('NEM blokkol a hírlevél-űrlap hCaptcha widgetje miatt', () => {
    const v = evaluateResponse({
      status: 200,
      body: shopPage() + '<div class="h-captcha" data-sitekey="abc"></div>',
      contentType: 'text/html', url: 'https://x.hu/p/1',
    });
    expect(v.blocked).toBe(false);
  });

  it('NEM blokkol, ha a lábléc korhatár-szöveget tartalmaz, de a termék ott van', () => {
    const v = evaluateResponse({
      status: 200,
      body: shopPage() + '<footer>Elmúltam 18 éves. Az alkohol fogyasztása…</footer>',
      contentType: 'text/html', url: 'https://x.hu/p/1',
    });
    expect(v.blocked).toBe(false);
  });

  it('NEM blokkol a bejelentkezési űrlap jelenléte miatt egy normál oldalon', () => {
    const v = evaluateResponse({
      status: 200,
      body: shopPage() + '<form class="login-form"><input type="password"></form>',
      contentType: 'text/html', url: 'https://x.hu/p/1',
    });
    expect(v.blocked).toBe(false);
  });
});

describe('challenge-felismerés — valódi blokkolás', () => {
  it('felismeri a Cloudflare challenge oldalt', () => {
    const v = evaluateResponse({
      status: 200,
      body: '<html><head><title>Just a moment...</title></head><body><div id="cf-browser-verification"></div></body></html>',
      contentType: 'text/html', url: 'https://x.hu',
    });
    expect(v.blocked).toBe(true);
    expect(v.reason).toBe('challenge');
  });

  it('felismeri a tartalom nélküli CAPTCHA-falat', () => {
    const v = evaluateResponse({
      status: 200,
      body: '<html><body><div class="g-recaptcha" data-sitekey="x"></div><p>Kérjük igazolja.</p></body></html>',
      contentType: 'text/html', url: 'https://x.hu',
    });
    expect(v.blocked).toBe(true);
    expect(v.reason).toBe('challenge');
  });

  it('felismeri az üres JS shellt', () => {
    const v = evaluateResponse({
      status: 200,
      body: '<html><body><div id="root"></div><script src="/app.js"></script></body></html>',
      contentType: 'text/html', url: 'https://x.hu',
    });
    expect(v.blocked).toBe(true);
    expect(v.reason).toBe('empty_shell');
  });

  it('felismeri a korhatár-kaput termékadat nélkül', () => {
    const v = evaluateResponse({
      status: 200,
      body: '<html><body><h1>Elmúltam 18 éves?</h1><button>Igen</button></body></html>',
      contentType: 'text/html', url: 'https://x.hu',
    });
    expect(v.blocked).toBe(true);
    expect(v.reason).toBe('age_gate');
  });

  it('a 429 sebességkorlátozás, nem "nincs termék"', () => {
    const v = evaluateResponse({ status: 429, body: '', contentType: 'text/html', url: 'https://x.hu' });
    expect(v.blocked).toBe(true);
    expect(v.reason).toBe('rate_limited');
  });

  it('a soft 404 nem lesz üzleti "nincs találat"', () => {
    const v = evaluateResponse({
      status: 200,
      body: '<html><head><title>A keresett oldal nem található</title></head><body>' +
            '<p>Sajnáljuk, a keresett oldal nem található. Kérjük, használja a keresőt vagy ' +
            'térjen vissza a főoldalra. Az alábbi kategóriákban böngészhet tovább: borok, ' +
            'pezsgők, töményitalok, ajándékcsomagok, kiegészítők és pohárkészletek.</p></body></html>',
      contentType: 'text/html', url: 'https://x.hu/nincs',
    });
    expect(v.blocked).toBe(true);
    expect(v.reason).toBe('soft_404');
  });

  it('a JSON válasz nem esik át a HTML-heurisztikán', () => {
    const v = evaluateResponse({
      status: 200, body: '[{"id":1,"name":"Bor"}]',
      contentType: 'application/json', url: 'https://x.hu/wp-json/wc/store/v1/products',
    });
    expect(v.blocked).toBe(false);
  });
});

describe('SSRF-védelem (spec 29.1)', () => {
  it('felismeri a privát és belső címtartományokat', () => {
    for (const ip of ['10.0.0.1', '127.0.0.1', '192.168.1.1', '172.16.0.1',
                      '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fe80::1', 'fd00::1']) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
  });

  it('a publikus címeket átengedi', () => {
    for (const ip of ['1.1.1.1', '8.8.8.8', '93.184.216.34', '2606:4700::1111']) {
      expect(isPrivateAddress(ip), ip).toBe(false);
    }
  });
});
