/**
 * A felderites folytatasi pontja.
 *
 * A hiba, amit ez a modul javit: a `gentle` policy 0,5 keres/mp uteme es a
 * 40 perces futasi korlat szorzata pontosan 1200 keres. Mivel minden futas a
 * cellista elejerol indult, egy 3000 termekes bolt katalogusa tartosan
 * 1200-nal ragadt - a 1201. termek SOHA nem kerult sorra.
 */
import { describe, it, expect } from 'vitest';
import { rotateToResumePoint } from '../../apps/worker/src/lib/discovery-cursor.js';

const t = (n: number) => ({ url: `https://bolt.hu/termek/${n}` });
const catalog = (size: number) => Array.from({ length: size }, (_, i) => t(i));

describe('folytatasi pont', () => {
  it('folytatasi pont nelkul az elejerol indul', () => {
    const r = rotateToResumePoint(catalog(5), null);
    expect(r.startIndex).toBe(0);
    expect(r.targets.map((x) => x.url)).toEqual(catalog(5).map((x) => x.url));
  });

  it('a folytatasi ponttol indul, es a lista vegen korbefordul', () => {
    const r = rotateToResumePoint(catalog(5), t(3).url);
    expect(r.startIndex).toBe(3);
    expect(r.targets.map((x) => x.url)).toEqual([
      t(3).url, t(4).url, t(0).url, t(1).url, t(2).url,
    ]);
  });

  it('a teljes lista megmarad - forgatas, nem levagas', () => {
    const r = rotateToResumePoint(catalog(1000), t(700).url);
    expect(r.targets).toHaveLength(1000);
    expect(new Set(r.targets.map((x) => x.url)).size).toBe(1000);
  });
});

describe('a cellista valtozasa ket futas kozott', () => {
  it('ha a folytatasi URL eltunt, az elejerol kezdunk es jelezzuk', () => {
    // Inkabb dolgozzunk fel valamit ketszer, mint hogy kihagyjunk egy szeletet.
    const r = rotateToResumePoint(catalog(5), 'https://bolt.hu/termek/mar-nem-letezik');
    expect(r.startIndex).toBe(0);
    expect(r.resumePointLost).toBe(true);
  });

  it('eltolodott lista eseten is a HELYES termeknel folytat', () => {
    // Ez az oka annak, hogy URL-t tarolunk es nem indexet: ha ket uj termek
    // kerult a lista elejere, a regi index 2-vel elcsuszna, es ket termek
    // nema atugrast szenvedne.
    const elozo = catalog(5);
    const most = [t(100), t(101), ...elozo];
    const r = rotateToResumePoint(most, t(3).url);
    expect(r.targets[0]?.url).toBe(t(3).url);
    expect(r.resumePointLost).toBe(false);
  });
});

describe('a katalogus tobb futas alatt teljesen bejarhato', () => {
  it('1200-as futasonkenti kerettel egy 3000 termekes bolt 3 futas alatt kesz', () => {
    const BUDGET = 1200;          // 40 perc x 0,5 keres/mp
    const teljes = catalog(3000);
    const feldolgozott = new Set<string>();
    let resume: string | null = null;

    for (let futas = 1; futas <= 3; futas++) {
      const { targets } = rotateToResumePoint(teljes, resume);
      const szelet = targets.slice(0, BUDGET);
      for (const x of szelet) feldolgozott.add(x.url);
      resume = targets[BUDGET]?.url ?? null;
    }

    expect(feldolgozott.size).toBe(3000);
  });

  it('a regi viselkedes ugyanezen a katalogusnal 1200-nal ragadt', () => {
    // Regresszios ellenpelda: folytatasi pont nelkul minden futas ugyanazt az
    // elso 1200 termeket dolgozza fel.
    const BUDGET = 1200;
    const teljes = catalog(3000);
    const feldolgozott = new Set<string>();

    for (let futas = 1; futas <= 3; futas++) {
      for (const x of teljes.slice(0, BUDGET)) feldolgozott.add(x.url);
    }

    expect(feldolgozott.size).toBe(1200);
  });
});
