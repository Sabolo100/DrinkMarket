/**
 * A szallitasi felteteleket nem szabad ajanlatnak venni.
 *
 * A `/Offer/i` minta illeszkedett az `OfferShippingDetails`-re is - vagyis egy
 * szallitasi node ajanlatkent kerulhetett be. Egy ilyen node
 * `freeShippingThreshold`-ja pedig pontosan az a szam, amit sosem szabad
 * termekarnak venni.
 *
 * A valos rendszerben egy webshop 3 696 termekebol 3 661 kapott ugyanazt a
 * 15 000 Ft-ot, es a kinyeres tobbsegeben a JSON-LD nyert - a DOM-agat vedo
 * szovegszuro tehat hozza sem ert.
 */
import { describe, it, expect } from 'vitest';
import { extractJsonLdProduct } from '../../packages/extraction/src/jsonld.js';

function page(nodes: unknown): string {
  return `<html><head><script type="application/ld+json">${JSON.stringify(nodes)}</script></head><body></body></html>`;
}

describe('a valodi ajanlat atmegy', () => {
  it('Offer', () => {
    const r = extractJsonLdProduct(page({
      '@type': 'Product', name: 'Sauska Kékfrankos 2019',
      offers: { '@type': 'Offer', price: '4990', priceCurrency: 'HUF' },
    }));
    expect(r!.offers.map((o) => o.price)).toEqual([4990]);
  });

  it('AggregateOffer', () => {
    const r = extractJsonLdProduct(page({
      '@type': 'Product', name: 'X',
      offers: { '@type': 'AggregateOffer', lowPrice: '3200', priceCurrency: 'HUF' },
    }));
    expect(r!.offers.map((o) => o.price)).toEqual([3200]);
  });

  it('teljes schema.org URL-lel megadott tipus is', () => {
    const r = extractJsonLdProduct(page({
      '@type': 'Product', name: 'X',
      offers: { '@type': 'https://schema.org/Offer', price: '2500' },
    }));
    expect(r!.offers.map((o) => o.price)).toEqual([2500]);
  });
});

describe('a szallitasi node NEM ajanlat', () => {
  it('OfferShippingDetails kiesik', () => {
    // Ez a lenyeg: a regi `/Offer/i` minta ezt is elfogadta.
    const r = extractJsonLdProduct(page({
      '@type': 'Product', name: 'Borbély Rózsakő 2024',
      offers: [
        { '@type': 'OfferShippingDetails', price: '15000', priceCurrency: 'HUF' },
      ],
    }));
    expect(r!.offers).toHaveLength(0);
  });

  it('a valodi ar megmarad a szallitasi node mellett is', () => {
    const r = extractJsonLdProduct(page({
      '@type': 'Product', name: 'Folly Olaszrizling 2024',
      offers: [
        { '@type': 'OfferShippingDetails', price: '15000' },
        { '@type': 'Offer', price: '3667', priceCurrency: 'HUF' },
      ],
    }));
    expect(r!.offers.map((o) => o.price)).toEqual([3667]);
  });
});
