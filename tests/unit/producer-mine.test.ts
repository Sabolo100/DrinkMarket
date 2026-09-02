/**
 * Boraszat-jeloltek banyaszasa.
 *
 * Az elso valos meres tanulsaga rogzitve: a puszta szogyakorisag
 * hasznalhatatlan volt. A 20208 listing rangsoranak tetejen ezek alltak:
 *
 *   eves 841 · chateau 475 · cask 371 · gin 295 · the 276 · whisky 2239
 *
 * Egyetlen boraszat sem. Ezek a tesztek azt bizonyitjak, hogy a harom
 * javitas - termelonev-jelolok, pozicio, boltok kozti tamogatottsag -
 * kiemeli a valodi neveket a zajbol.
 */
import { describe, it, expect } from 'vitest';
import {
  mineProducerCandidates, looksLikeHungarianPersonName, type MineInput,
} from '@radovin/domain';

/** Egy listing maradeka a slot-kitoltes utan. */
function listing(shopKey: string, rawName: string, residue: string): MineInput {
  return { shopKey, rawName, residueTokens: residue.split(' ').filter(Boolean) };
}

/** Ugyanaz a maradek N boltbol, hogy atmenjen a tamogatottsagi kuszobon. */
function inShops(residue: string, shops: string[], rawName = residue): MineInput[] {
  return shops.map((s) => listing(s, rawName, residue));
}

function names(cands: ReturnType<typeof mineProducerCandidates>): string[] {
  return cands.map((c) => c.name);
}

describe('termelonev-jelolok', () => {
  it('a Château a nev RESZE, nem zaj', () => {
    // Ez forditotta meg a korabbi kovetkeztetest: a 'chateau' 475
    // elofordulassal a zajlista tetejen allt, holott a "Château Margaux"
    // maga a pinceszet neve.
    const inputs = [
      ...inShops('chateau margaux', ['a', 'a', 'a']),
    ];
    const out = mineProducerCandidates(inputs, { minCount: 3, minShops: 2 });
    expect(names(out)).toContain('chateau margaux');
    expect(out.find((c) => c.name === 'chateau margaux')?.hasMarker).toBe(true);
  });

  it('a jelolos nev EGYETLEN boltbol is jelolt', () => {
    // Egy kulfoldi birtok gyakran kizarolagos egy boltnal - a jelolo
    // onmagaban eleg bizonyitek, nem varunk tobbboltos tamogatast.
    const inputs = [
      listing('a', 'Domaine Leflaive Puligny 2019', 'domaine leflaive puligny'),
      listing('a', 'Domaine Leflaive Bourgogne 2020', 'domaine leflaive bourgogne'),
      listing('a', 'Domaine Leflaive Macon 2021', 'domaine leflaive macon'),
    ];
    const out = mineProducerCandidates(inputs, { minCount: 3, minShops: 2 });
    expect(names(out)).toContain('domaine leflaive');
  });

  it('a magyar jelolo UTOTAG, es a nev resze', () => {
    const inputs = [
      ...inShops('jasdi pince', ['a', 'b']),
      ...inShops('gilvesy pinceszet', ['a', 'b']),
      ...inShops('takler borbirtok', ['a', 'b']),
    ];
    const out = mineProducerCandidates(inputs, { minCount: 2, minShops: 2 });
    expect(names(out)).toEqual(expect.arrayContaining([
      'jasdi pince', 'gilvesy pinceszet', 'takler borbirtok',
    ]));
  });
});

describe('a zaj kiszurese', () => {
  it('a tomeny- es kereskedelmi szokincs nem lehet jelolt', () => {
    // Pontosan azok a tokenek, amik a valos meresben a lista elejet vittek.
    const zaj = ['whisky', 'cask', 'single', 'reserve', 'eves', 'the', 'premium', 'gin'];
    const inputs = zaj.flatMap((z) => inShops(`${z} valami`, ['a', 'b', 'c']));
    const out = mineProducerCandidates(inputs, { minCount: 3, minShops: 2 });
    for (const z of zaj) {
      expect(names(out).some((n) => n.startsWith(z))).toBe(false);
    }
  });

  it('szammal kezdodo vagy szamot tartalmazo jelolt nincs', () => {
    const inputs = [
      ...inShops('12 eves valami', ['a', 'b', 'c']),
      ...inShops('1942 kulonleges', ['a', 'b', 'c']),
    ];
    const out = mineProducerCandidates(inputs, { minCount: 3, minShops: 2 });
    expect(out.every((c) => !/\d/.test(c.name))).toBe(true);
  });
});

describe('boltok kozti tamogatottsag', () => {
  it('az egyboltos, jelolo nelkuli nev kimarad', () => {
    const inputs = inShops('valamilyen fantazianev', ['csak-egy-bolt', 'csak-egy-bolt', 'csak-egy-bolt']);
    const out = mineProducerCandidates(inputs, { minCount: 3, minShops: 2 });
    expect(out).toHaveLength(0);
  });

  it('a tobbboltos nev bekerul, es elorebb rangsorolodik', () => {
    const inputs = [
      ...inShops('sauska', ['a', 'b', 'c', 'd']),
      ...inShops('kevesbe ismert', ['a', 'b']),
    ];
    const out = mineProducerCandidates(inputs, { minCount: 2, minShops: 2 });
    const sauska = out.findIndex((c) => c.name === 'sauska');
    const masik = out.findIndex((c) => c.name === 'kevesbe ismert');
    expect(sauska).toBeGreaterThanOrEqual(0);
    expect(sauska).toBeLessThan(masik);
  });
});

describe('magyar szemelynev-felismeres', () => {
  it('a Vezeteknev Keresztnev mintat felismeri', () => {
    expect(looksLikeHungarianPersonName('Gere Attila')).toBe(true);
    expect(looksLikeHungarianPersonName('Bolyki János')).toBe(true);
    expect(looksLikeHungarianPersonName('Szepsy István')).toBe(true);
    expect(looksLikeHungarianPersonName('Bott Frigyes')).toBe(true);
  });

  it('a nem szemelynevet nem jeloli meg', () => {
    expect(looksLikeHungarianPersonName('Sauska')).toBe(false);
    expect(looksLikeHungarianPersonName('Chateau Margaux')).toBe(false);
    expect(looksLikeHungarianPersonName('Takler Borbirtok')).toBe(false);
  });

  it('a szemelynev-jelzes megjelenik a jelolten', () => {
    // Ez nem kozmetika: a szemelynev-alapu pinceszeteknel a fuzzy egyezes
    // TILOS (spec 13.3) - a "Gere Attila" es a "Gere Zsolt" ket kulon
    // boraszat, a trigram-hasonlosaguk viszont magas.
    const out = mineProducerCandidates(inShops('gere attila', ['a', 'b']), { minCount: 2, minShops: 2 });
    expect(out.find((c) => c.name === 'gere attila')?.personName).toBe(true);
  });
});

describe('bizonyitek a jovahagyashoz', () => {
  it('minden jelolt visz peldat a nyers nevekbol', () => {
    const inputs = [
      listing('a', 'Sauska Kékfrankos 2019', 'sauska'),
      listing('b', 'SAUSKA Furmint 2021', 'sauska'),
    ];
    const out = mineProducerCandidates(inputs, { minCount: 2, minShops: 2 });
    expect(out[0]?.examples.length).toBeGreaterThan(0);
    expect(out[0]?.examples[0]).toContain('Sauska');
  });
});
