/**
 * Boraszat-osszevonasi javaslatok.
 *
 * A valos rendszerben a banyaszat n-gramokbol dolgozik, ezert ugyanarrol a
 * pinceszetrol tobb jeloltet is elohoz. A felhasznalo ezt latta:
 * "Sauska Extra Dry", "Sauska Brut", "Sauska Puttonyos" - harom kulon
 * `producer` sor, harom kulon termelo, es a boraik soha nem parosodnak.
 *
 * A masik ag ennel is gyakoribb: "Bock" es "Bock Pince" ugyanaz a birtok, a
 * masodik csak a magyar utotag-jelolot viseli.
 *
 * A teszt ket dolgot vedd: hogy ezek OSSZEKERULNEK, es hogy a "Gere Attila"
 * ↔ "Gere Zsolt" par NEM kap magas bizonyossagot - az ket kulon boraszat
 * (spec 13.3), es egy magabiztos javaslat itt valodi kart okozna.
 */
import { describe, it, expect } from 'vitest';
import { producerMergeKey, groupMergeCandidates, type MergeMember } from '@radovin/domain';

function m(
  id: string, canonicalName: string, extra: Partial<MergeMember> = {},
): MergeMember {
  return {
    id, canonicalName, status: 'proposed', linkedListings: 0,
    candidateScore: 10, personName: false, fuzzyBlocked: false, ...extra,
  };
}

describe('csoportkulcs', () => {
  it('a bor-szokincset levagja a nevrol', () => {
    expect(producerMergeKey('Sauska Extra Dry')).toBe('sauska');
    expect(producerMergeKey('Sauska Brut')).toBe('sauska');
    expect(producerMergeKey('Sauska Puttonyos')).toBe('sauska');
    expect(producerMergeKey('Sauska')).toBe('sauska');
  });

  it('a magyar utotag-jelolot levagja', () => {
    expect(producerMergeKey('Bock')).toBe('bock');
    expect(producerMergeKey('Bock Pince')).toBe('bock');
    expect(producerMergeKey('Bock Pincészet')).toBe('bock');
    expect(producerMergeKey('Bock Borászat Kft.')).toBe('bock');
  });

  it('az ekezet nem szamit', () => {
    expect(producerMergeKey('Thummerer Pincészet')).toBe('thummerer');
    expect(producerMergeKey('Gilvesy Pincészet')).toBe('gilvesy');
  });

  it('elotag-jelolonel KET token a kulcs', () => {
    // A puszta "chateau" nem azonosit: a Margaux es a Palmer ket kulon birtok.
    expect(producerMergeKey('Château Margaux')).toBe('chateau margaux');
    expect(producerMergeKey('Château Palmer')).toBe('chateau palmer');
    expect(producerMergeKey('Château Margaux')).not.toBe(producerMergeKey('Château Palmer'));
  });

  it('ures kulcs, ha a nevben nem marad azonosito', () => {
    expect(producerMergeKey('Pince')).toBe('');
    expect(producerMergeKey('Borászat Kft.')).toBe('');
  });
});

describe('csoportositas', () => {
  it('a Sauska-valtozatok egy csoportba kerulnek', () => {
    const groups = groupMergeCandidates([
      m('1', 'Sauska Extra Dry'),
      m('2', 'Sauska Brut'),
      m('3', 'Sauska Puttonyos'),
      m('4', 'Takler Borbirtok'),
    ]);
    const sauska = groups.find((g) => g.key === 'sauska');
    expect(sauska?.members.map((x) => x.id).sort()).toEqual(['1', '2', '3']);
    // Egyetlen tag nem csoport.
    expect(groups.some((g) => g.key === 'takler')).toBe(false);
  });

  it('a "Bock" ⊂ "Bock Pince" par prefix-csoport, magas bizonyossaggal', () => {
    const groups = groupMergeCandidates([m('1', 'Bock'), m('2', 'Bock Pince')]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.kind).toBe('prefix');
    expect(groups[0]!.confidence).toBe('high');
  });

  it('a Sauska-valtozatok NEM prefix-csoport', () => {
    // "sauska brut" es "sauska extra dry" egyike sem kezdete a masiknak.
    const groups = groupMergeCandidates([m('1', 'Sauska Brut'), m('2', 'Sauska Extra Dry')]);
    expect(groups[0]!.kind).toBe('token');
    expect(groups[0]!.confidence).toBe('medium');
  });

  it('szemelynevnel figyelmeztet, es sosem ad magas bizonyossagot', () => {
    // Ez a legfontosabb vedelem: a "Gere Attila" es a "Gere Zsolt" KET kulon
    // boraszat. A javaslat megjelenhet, de nem allhat magabiztosan.
    const groups = groupMergeCandidates([
      m('1', 'Gere Attila', { personName: true, fuzzyBlocked: true }),
      m('2', 'Gere Zsolt', { personName: true, fuzzyBlocked: true }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.confidence).toBe('medium');
    expect(groups[0]!.warnings.join(' ')).toContain('Szemelynev');
  });

  it('a szemelynev-figyelmeztetes a prefix-agat is lefogja', () => {
    const groups = groupMergeCandidates([
      m('1', 'Gere', { personName: true }),
      m('2', 'Gere Attila', { personName: true }),
    ]);
    expect(groups[0]!.kind).toBe('prefix');
    expect(groups[0]!.confidence).toBe('medium');
  });

  it('a mar eldontott sorok kimaradnak', () => {
    const groups = groupMergeCandidates([
      m('1', 'Bock Pince'),
      m('2', 'Bock', { status: 'retired' }),
      m('3', 'Bock Borászat', { status: 'merged' }),
    ]);
    // Egyetlen elo tag maradt - az nem csoport.
    expect(groups).toHaveLength(0);
  });
});

describe('a javasolt tulelo', () => {
  it('a jovahagyott sor nyer a jelolt ellen', () => {
    const groups = groupMergeCandidates([
      m('1', 'Sauska Brut', { linkedListings: 40 }),
      m('2', 'Sauska', { status: 'active', linkedListings: 3 }),
    ]);
    expect(groups[0]!.suggestedKeepId).toBe('2');
  });

  it('azonos allapotnal a tobb kotott termek nyer', () => {
    // A legkevesebb mozgatas a legkisebb kockazat.
    const groups = groupMergeCandidates([
      m('1', 'Sauska Brut', { linkedListings: 2 }),
      m('2', 'Sauska Extra Dry', { linkedListings: 31 }),
    ]);
    expect(groups[0]!.suggestedKeepId).toBe('2');
  });

  it('azonos sulynal a ROVIDEBB nev nyer', () => {
    // A boraszat neve "Sauska", nem "Sauska Extra Dry" - a hosszabb valtozat
    // a bor nevet is magaban hordja.
    const groups = groupMergeCandidates([
      m('1', 'Sauska Extra Dry'),
      m('2', 'Sauska'),
    ]);
    expect(groups[0]!.suggestedKeepId).toBe('2');
  });

  it('ket jovahagyott tagnal figyelmeztet a listingek mozgasara', () => {
    const groups = groupMergeCandidates([
      m('1', 'Bock', { status: 'active', linkedListings: 12 }),
      m('2', 'Bock Pince', { status: 'active', linkedListings: 5 }),
    ]);
    expect(groups[0]!.warnings.join(' ')).toContain('jova van hagyva');
    expect(groups[0]!.confidence).toBe('medium');
  });
});

describe('rangsor', () => {
  it('a legtobb erintett termeket hozo csoport all elol', () => {
    const groups = groupMergeCandidates([
      m('1', 'Kis Pince', { linkedListings: 1 }),
      m('2', 'Kis Borászat', { linkedListings: 1 }),
      m('3', 'Nagy Pince', { linkedListings: 90 }),
      m('4', 'Nagy Borbirtok', { linkedListings: 60 }),
    ]);
    expect(groups[0]!.key).toBe('nagy');
  });
});
