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
