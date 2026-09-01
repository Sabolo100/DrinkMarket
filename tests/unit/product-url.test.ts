/**
 * Termek-URL felismeres.
 *
 * A valos hiba, amit ez a teszt rogzit: a radovin sitemapjaban ott vannak a
 * WooCommerce cimke-archivumok (/termekcimke/badacsony/), es 265 ilyen oldal
 * TERMEKKENT kerult a katalogusba. A "terméknev" a cimke neve lett
 * ("badacsony", "aurum", "balaton").
 *
 * Ket ok egyutt:
 *   1. a regi szures SZOVEGES reszletet keresett, ezert a '/cimke/' minta nem
 *      fogta meg a '/termekcimke/'-t - a "cimke" elott a "termek" szo vege all,
 *      nem perjel;
 *   2. az archivumoldal <h1>-e nevnek latszik, ezert a kinyeres sem vette
 *      eszre, hogy nem termekrol van szo.
 */
import { describe, it, expect } from 'vitest';
import { looksLikeProductUrl } from '@radovin/extraction';

const R = 'https://radovin.hu';

describe('archivumoldalak kizarasa', () => {
  it('a WooCommerce magyar cimke-archivum NEM termek', () => {
    // Ez a konkret URL szennyezte a katalogust.
    expect(looksLikeProductUrl(`${R}/termekcimke/badacsony/`)).toBe(false);
    expect(looksLikeProductUrl(`${R}/termekcimke/aurum/`)).toBe(false);
  });

  it('a WooCommerce angol cimke- es kategoria-archivum sem termek', () => {
    expect(looksLikeProductUrl(`${R}/product-tag/badacsony/`)).toBe(false);
    expect(looksLikeProductUrl(`${R}/product-category/voros/`)).toBe(false);
    expect(looksLikeProductUrl(`${R}/termekkategoria/voros/`)).toBe(false);
  });

  it('szerzo- es lapozooldal sem termek', () => {
    expect(looksLikeProductUrl(`${R}/szerzo/kovacs/`)).toBe(false);
    expect(looksLikeProductUrl(`${R}/oldal/3/`)).toBe(false);
  });
});

describe('valodi termekoldalak megmaradnak', () => {
  it('a WooCommerce termekoldal termek', () => {
    expect(looksLikeProductUrl(`${R}/termek/jakab-pinot-noir-easy-2023-badacsonyi-13-075l/`)).toBe(true);
    expect(looksLikeProductUrl(`${R}/termek/dictador-aurum-40-07l/`)).toBe(true);
  });

  it('a Shopify /collections/.../products/... forma termek', () => {
    // Ez a legfontosabb ellenpelda: a 'collections' szakasz archivumnak
    // latszana, de a 'products' szakasz felulirja. Vak kizarassal a teljes
    // Shopify katalogus elveszne.
    expect(looksLikeProductUrl('https://winehub.hu/collections/all/products/furmint-2021')).toBe(true);
    expect(looksLikeProductUrl('https://winehub.hu/products/furmint-2021')).toBe(true);
  });

  it('a termeknev tartalmazhat archivumra emlekezteto szot', () => {
    // A slug csak a 'termek' szakasz UTAN all, ezert nem keverheto ossze.
    expect(looksLikeProductUrl(`${R}/termek/badacsonyi-olaszrizling-2023/`)).toBe(true);
  });
});

describe('forrasspecifikus konfiguracio mindent felulir', () => {
  it('az explicit include szukiti a kort', () => {
    expect(looksLikeProductUrl(`${R}/valami/mas/`, { include: ['/termek/'] })).toBe(false);
    expect(looksLikeProductUrl(`${R}/termek/bor/`, { include: ['/termek/'] })).toBe(true);
  });

  it('az explicit exclude a termekutvonalat is kizarja', () => {
    expect(looksLikeProductUrl(`${R}/termek/ajandekutalvany/`, { exclude: ['ajandekutalvany'] })).toBe(false);
  });
});

describe('a regi viselkedes regresszios ellenpeldaja', () => {
  it('a puszta szovegkereses atengedte volna a cimke-archivumot', () => {
    // Igy nezett ki a regi szabaly. Rogzitjuk, hogy miert volt rossz.
    const regiMinta = '/cimke/';
    expect(`${R}/termekcimke/badacsony/`.includes(regiMinta)).toBe(false);
    // ...es hogy az uj szabaly mar megfogja:
    expect(looksLikeProductUrl(`${R}/termekcimke/badacsony/`)).toBe(false);
  });
});
