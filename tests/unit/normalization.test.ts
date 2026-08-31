import { describe, it, expect } from 'vitest';
import {
  searchNorm, retrievalForm, trigramSimilarity, nameSimilarity, stripNoiseTerms,
  parseVolume, parsePackaging, parseAbv, volumeEquivalent, packagingEquivalent,
  parseVintage, parseAgeStatement, parsePuttony, vintageContradiction,
  parseMoney, toHuf, selectComparablePrice, detectPriceAnomaly, computeMarketPosition,
} from '@radovin/domain';
import { emptyPriceSnapshot } from '@radovin/contracts';

describe('szovegnormalizalas (spec 13.1)', () => {
  it('ekezetmentesit es kisbetusit, de a jelentest orzi', () => {
    expect(searchNorm('Gere Róka Pinot Noir')).toBe('gere roka pinot noir');
    expect(searchNorm('Tokaji Aszú 6 puttonyos')).toBe('tokaji aszu 6 puttonyos');
  });

  it('egysegesiti a tipografiai karaktereket', () => {
    expect(searchNorm('6 × 0,75 l')).toBe('6 x 0,75 l');
    expect(searchNorm('Whisky – Single Malt')).toBe('whisky single malt');
  });

  it('dekodolja a HTML entitasokat', () => {
    expect(searchNorm('Ch&acirc;teau &amp; Co')).toContain('co');
    expect(searchNorm('Tokaji Asz&uacute;')).toBe('tokaji aszu');
  });

  it('normalizalja a kontrollalt roviditeseket', () => {
    expect(retrievalForm('Hennessy X.O.')).toBe('hennessy xo');
    expect(retrievalForm('Martell V.S.O.P.')).toBe('martell vsop');
  });

  it('NEM dob el identitashordozo szavakat zajszokent (spec 13.2)', () => {
    const noise = ['akcio', 'rendeld meg', 'palack'];
    const s = stripNoiseTerms(searchNorm('Johnnie Walker Double Black akcio palack'), noise);
    expect(s).toContain('double');
    expect(s).toContain('black');
    expect(s).not.toContain('akcio');
  });

  it('hasonlosagi mertekek 0..1 kozott mozognak', () => {
    expect(trigramSimilarity('gere roka', 'gere roka')).toBe(1);
    expect(nameSimilarity('johnnie walker black label', 'johnnie walker double black')).toBeLessThan(0.9);
    expect(nameSimilarity('gere roka pinot noir 2023', 'gere roka pinot noir')).toBeGreaterThan(0.6);
  });
});

describe('mennyiseg es csomag (spec 13.4)', () => {
  it('minden mertekegyseget ml-re hoz', () => {
    expect(parseVolume('0,75 l').unitVolumeMl).toBe(750);
    expect(parseVolume('0.7L').unitVolumeMl).toBe(700);
    expect(parseVolume('70 cl').unitVolumeMl).toBe(700);
    expect(parseVolume('700 ml').unitVolumeMl).toBe(700);
    expect(parseVolume('1,5 l Magnum').unitVolumeMl).toBe(1500);
  });

  it('a csomagot NEM olvasztja ossze osszterfogatta', () => {
    const r = parseVolume('6x0,75 l karton');
    expect(r.unitVolumeMl).toBe(750);
    expect(r.packCount).toBe(6);
    expect(r.totalVolumeMl).toBe(4500);
  });

  it('felismeri a forditott sorrendu csomagjelolest', () => {
    const r = parseVolume('0,75 l x 6');
    expect(r.unitVolumeMl).toBe(750);
    expect(r.packCount).toBe(6);
  });

  it('max 5 ml formazasi tolerancia (spec 15.3)', () => {
    expect(volumeEquivalent(700, 700)).toBe(true);
    expect(volumeEquivalent(700, 703)).toBe(true);
    expect(volumeEquivalent(700, 750)).toBe(false);
    expect(volumeEquivalent(750, 1500)).toBe(false);
  });

  it('a diszdoboz alapertelmezesben NEM azonos eladhato valtozat (spec 3.1)', () => {
    expect(parsePackaging('Tokaji Aszu diszdoboz').packagingType).toBe('gift_box');
    expect(parsePackaging('Chivas Regal fadoboz').packagingType).toBe('wooden_case');
    expect(packagingEquivalent('standard', 'gift_box', { giftBoxEquivalent: false })).toBe(false);
    expect(packagingEquivalent('standard', 'gift_box', { giftBoxEquivalent: true })).toBe(true);
  });

  it('alkoholtartalmat parszol', () => {
    expect(parseAbv('40% vol').value).toBe(40);
    expect(parseAbv('13,5 %').value).toBe(13.5);
    expect(parseAbv('nincs adat').value).toBeNull();
  });
});

describe('evjarat es korjeloles (spec 13.5)', () => {
  it('kinyeri az evjaratot a nevbol', () => {
    expect(parseVintage('Gere Roka 2023').value).toBe(2023);
    expect(parseVintage('Bukolyi Joy 2019').value).toBe(2019);
  });

  it('felismeri a non-vintage jelolest', () => {
    expect(parseVintage('Moet Chandon Brut NV').status).toBe('non_vintage');
    expect(parseVintage('Champagne non-vintage').status).toBe('non_vintage');
  });

  it('tobb evszam eseten unknown marad, nem talal ki (spec 12.4)', () => {
    const r = parseVintage('Bortarsasag 2019 2020 valogatas');
    expect(r.value).toBeNull();
    expect(r.status).toBe('unknown');
    expect(r.candidates.length).toBe(2);
  });

  it('az URL-bol szarmazo ev gyenge konfidenciaju (spec 13.5)', () => {
    const fromUrl = parseVintage('/bor/gere-roka-2022', 'url');
    const fromName = parseVintage('Gere Roka 2022', 'name');
    expect(fromUrl.confidence).toBeLessThan(fromName.confidence);
  });

  it('nem tekinti evjaratnak az alapitasi evet', () => {
    expect(parseVintage('Pinceszet alapitva 1904').value).toBeNull();
  });

  it('korjelolest es puttonyszamot kulon kezel', () => {
    expect(parseAgeStatement('Glenfiddich 12 Years Old').years).toBe(12);
    expect(parseAgeStatement('Chivas Regal 18 eves').years).toBe(18);
    expect(parsePuttony('Tokaji Aszu 6 puttonyos').value).toBe(6);
    expect(parsePuttony('Tokaji Aszu 5 puttonyos').value).toBe(5);
  });

  it('evjarat-ellentmondast jelez, de az unknown nem ellentmondas (spec 15.2)', () => {
    expect(vintageContradiction({ value: 2022, status: 'vintage' }, { value: 2023, status: 'vintage' }).contradiction).toBe(true);
    expect(vintageContradiction({ value: null, status: 'non_vintage' }, { value: 2023, status: 'vintage' }).contradiction).toBe(true);
    expect(vintageContradiction({ value: null, status: 'unknown' }, { value: 2023, status: 'vintage' }).contradiction).toBe(false);
  });
});

describe('arkezeles (spec 12.3, 18.2, 18.4)', () => {
  it('magyar arformatumokat parszol', () => {
    expect(parseMoney('12 990 Ft')).toBe(12990);
    expect(parseMoney('12.990,-')).toBe(12990);
    expect(parseMoney('4 599')).toBe(4599);
    expect(parseMoney('1 299,50')).toBe(1299.5);
  });

  it('a minor unit alapjan valt at, NEM fixen 100-zal oszt (spec 12.3)', () => {
    expect(toHuf(1299000, 2)).toBe(12990);
    expect(toHuf(12990, 0)).toBe(12990);
    expect(toHuf('12990', 0)).toBe(12990);
  });

  it('csak a nyilvanos, egy darabra vonatkozo arat valasztja (spec 18.2)', () => {
    const p = { ...emptyPriceSnapshot(), regularPriceHuf: 15000, salePriceHuf: 12000, currentPriceHuf: 12000 };
    const r = selectComparablePrice(p, { allowedPriceTypes: ['regular', 'sale'], requireInStock: false });
    expect(r.selectedPriceHuf).toBe(12000);
    expect(r.priceType).toBe('sale');
    expect(r.comparable).toBe(true);
  });

  it('a csak klubtagoknak elerheto arat NEM teszi osszehasonlithatova', () => {
    const p = { ...emptyPriceSnapshot(), memberPriceHuf: 9900 };
    const r = selectComparablePrice(p, { allowedPriceTypes: ['regular', 'sale'], requireInStock: false });
    expect(r.comparable).toBe(false);
    expect(r.priceType).toBe('member');
  });

  it('felismeri a listaar/akcios ar felcsereleset', () => {
    const p = { ...emptyPriceSnapshot(), regularPriceHuf: 9000, currentPriceHuf: 12000, salePriceHuf: 12000 };
    const r = selectComparablePrice(p, { allowedPriceTypes: ['regular', 'sale'], requireInStock: false });
    expect(r.comparable).toBe(false);
  });

  it('karantenba teszi a nagysagrendi arvaltozast, de nem dobja el csendben', () => {
    const r = detectPriceAnomaly(1299000, 12990);
    expect(r.quarantine).toBe(true);
    expect(r.significance).toBe('extreme');
    expect(r.deltaPct).not.toBeNull();
  });

  it('minor unit hibat gyanit a piaci medianhoz kepest', () => {
    const r = detectPriceAnomaly(1299000, null, { marketMedianHuf: 12990 });
    expect(r.flags).toContain('MINOR_UNIT_SUSPECT_X100');
  });

  it('a normal arvaltozas nem kerul karantenba', () => {
    const r = detectPriceAnomaly(13500, 12990);
    expect(r.quarantine).toBe(false);
    expect(r.significance).toBe('normal');
  });
});

describe('piaci pozicio (spec 18.5)', () => {
  const base = { observedAt: new Date(), inStock: true, matchStatus: 'human_verified', stale: false };

  it('rangot es eltereseket szamol, a nevezo a valid ajanlatok szama', () => {
    const r = computeMarketPosition([
      { ...base, shopId: 'a', listingId: 'l1', priceHuf: 10000 },
      { ...base, shopId: 'b', listingId: 'l2', priceHuf: 12000 },
      { ...base, shopId: 'c', listingId: 'l3', priceHuf: 14000 },
    ]);
    expect(r.minPriceHuf).toBe(10000);
    expect(r.medianPriceHuf).toBe(12000);
    expect(r.maxPriceHuf).toBe(14000);
    expect(r.ranks.get('a')?.rank).toBe(1);
    expect(r.ranks.get('c')?.rank).toBe(3);
    expect(r.ranks.get('c')?.denominator).toBe(3);
    expect(r.ranks.get('c')?.deltaToMinPct).toBe(40);
  });

  it('holtversenyt jelez', () => {
    const r = computeMarketPosition([
      { ...base, shopId: 'a', listingId: 'l1', priceHuf: 10000 },
      { ...base, shopId: 'b', listingId: 'l2', priceHuf: 10000 },
    ]);
    expect(r.ranks.get('a')?.tied).toBe(true);
    expect(r.ranks.get('b')?.rank).toBe(1);
  });

  it('a stale ajanlat nem kerul a rangsorba', () => {
    const r = computeMarketPosition([
      { ...base, shopId: 'a', listingId: 'l1', priceHuf: 10000, stale: true },
      { ...base, shopId: 'b', listingId: 'l2', priceHuf: 12000 },
    ]);
    expect(r.offerCount).toBe(1);
    expect(r.minPriceHuf).toBe(12000);
  });
});
