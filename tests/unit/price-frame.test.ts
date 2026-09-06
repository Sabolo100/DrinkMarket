/**
 * A szallitasi kuszob NEM a termek ara.
 *
 * A valos rendszerben tobb szaz termek kapott pontosan 15 000 Ft-ot, mert a
 * vegso tartalek az oldalszoveg ELSO "... Ft" szamat vette - magyar
 * webshopon pedig az jellemzoen az "Ingyenes szallitas 15 000 Ft felett"
 * felirat. Az ertek minden termekoldalon ugyanaz, ezert a hiba nem egyetlen
 * rossz arat adott, hanem egy egesz bolt katalogusanak ugyanazt.
 *
 * Ez a fajta hiba a legdragabb: a rendszer nem tudja, hogy nem tudja, es
 * hamis ar-osszehasonlitast publikal.
 */
import { describe, it, expect } from 'vitest';
import { extractDomPrices } from '../../packages/extraction/src/price.js';

/** Termekoldal, amin CSAK a szallitasi savban van szam. */
const SHIPPING_ONLY = `
  <html><body>
    <div class="topbar">Ingyenes szállítás 15 000 Ft felett!</div>
    <h1>Sauska Kékfrankos 2019</h1>
    <div class="description">Villányi vörösbor, 14% alkohol.</div>
  </body></html>
`;

/** Ugyanaz, de a termek arat is kiirja - a kuszob elotte all. */
const SHIPPING_THEN_PRICE = `
  <html><body>
    <div class="topbar">Ingyenes szállítás 15 000 Ft felett!</div>
    <h1>Sauska Kékfrankos 2019</h1>
    <div class="termek-adat">A termék ára: 4 990 Ft</div>
  </body></html>
`;

/** A kuszob `price` osztalyu elemben - a CSS-osztaly nem dont. */
const SHIPPING_IN_PRICE_CLASS = `
  <html><body>
    <span class="price shipping-note">Ingyenes szállítás 15 000 Ft felett</span>
    <span class="price product-price">6 490 Ft</span>
  </body></html>
`;

describe('a szallitasi kuszob nem lehet ar', () => {
  it('csak kuszob van az oldalon -> INKABB semmi, mint hamis ar', () => {
    // A hianyzo arat a rendszer "nem osszehasonlithato"-kent kezeli es nem
    // publikalja. A hamisat viszont kiteszi a piacra.
    const r = extractDomPrices(SHIPPING_ONLY);
    expect(r.current).toBeNull();
  });

  it('a valodi arat megtalalja a kuszob mogott', () => {
    const r = extractDomPrices(SHIPPING_THEN_PRICE);
    expect(r.current).toBe(4990);
  });

  it('a `price` osztalyu kuszobot is kiszuri', () => {
    const r = extractDomPrices(SHIPPING_IN_PRICE_CLASS);
    expect(r.current).toBe(6490);
  });

  it('regresszio: a 15 000 SOHA nem szivarog at', () => {
    for (const html of [SHIPPING_ONLY, SHIPPING_THEN_PRICE, SHIPPING_IN_PRICE_CLASS]) {
      const r = extractDomPrices(html);
      expect(r.current).not.toBe(15000);
      expect(r.regular).not.toBe(15000);
    }
  });
});

describe('a szabalyos arat nem rontja el', () => {
  it('egyszeru termekar valtozatlanul jon', () => {
    const r = extractDomPrices('<span class="price">3 790 Ft</span>');
    expect(r.current).toBe(3790);
  });

  it('a "felett" szo egy termeknevben nem tesz karba', () => {
    // Ovatossag: a jelzo csak a szam KORNYEZETEBEN szamit, nem az egesz
    // oldalon - kulonben egy szerencsetlen termeknev kilonne a valodi arat.
    const r = extractDomPrices(
      '<div class="hirek">18 év felett!</div><span class="price">5 200 Ft</span>',
    );
    expect(r.current).toBe(5200);
  });
});

/**
 * A masodik szivargas: a keret szavai az elemen KIVUL.
 *
 * A winehub 3 661 termeke igy kapott 15 000 Ft-ot. A szuro csak az elem
 * SAJAT szoveget nezte, a szallitasi mondat viszont a szuloben allt, es a
 * szam egy beagyazott spanban - abban mar csak a puszta "15.000 Ft".
 *
 * Ugyanez a szabaly nem lohet ki valodi arat: egy termekar alatt allo
 * "Ingyenes szallitas" jelveny teljesen szabalyos, es a szomszed elem
 * kuszobe sem tartozik hozzank.
 */
describe('a keret az elemen kivul is lehet', () => {
  it('a szam beagyazott spanban, a mondat a szuloben', () => {
    const r = extractDomPrices(
      '<div class="shipping-banner">Ingyenes szállítás'
      + ' <span class="price">15.000 Ft</span> felett</div>',
    );
    expect(r.current).toBeNull();
  });

  it('kozbeeso inline tagek sem rejtik el a keretet', () => {
    const r = extractDomPrices(
      '<div class="ship"><b>Ingyenes kiszállítás</b>'
      + ' <span class="amount">15 000 Ft</span> <i>felett</i></div>',
    );
    expect(r.current).toBeNull();
  });

  it('a kuszob mogotti VALODI ar megmarad', () => {
    const r = extractDomPrices(
      '<div class="shipping-banner">Ingyenes szállítás'
      + ' <span class="price">15.000 Ft</span> felett</div>'
      + '<span class="price product-price">4 990 Ft</span>',
    );
    expect(r.current).toBe(4990);
  });

  it('az ar ALATT allo szallitasi jelveny nem teszi kuszobbe', () => {
    // A "szallitas" szo a szam MOGOTT mar egy kovetkezo felirat is lehet.
    // Ha ez kilone az arat, hianyzo arat kapnank ott, ahol van ar.
    const r = extractDomPrices(
      '<span class="price">5 200 Ft</span>'
      + '<div class="badge">Ingyenes szállítás 15 000 Ft felett</div>',
    );
    expect(r.current).toBe(5200);
  });

  it('a "felett" a szam MOGOTT dont, elotte artalmatlan', () => {
    const r = extractDomPrices(
      '<div><span class="price">15 000 Ft</span> felett ingyenes a szállítás</div>',
    );
    expect(r.current).toBeNull();
  });
});
