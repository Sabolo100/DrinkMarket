/**
 * A katalogus-felderites folytatasi pontja.
 *
 * A felderites futasonkent idokorlatos. A `gentle` crawl policy 0,5 keres/mp
 * uteme mellett a 40 perces korlat pontosan 1200 kerest jelent - ezert allt
 * meg tobb boltnal is ~1198 termeknel.
 *
 * A valodi baj nem a korlat volt, hanem hogy minden futas a cellista
 * ELEJEROL indult: a kovetkezo futas ugyanazt az elso 1200 termeket toltotte
 * le ujra, es a katalogus hatralevo resze soha nem kerult sorra.
 *
 * Ez a modul forgatja el a cellistat ugy, hogy a futas ott folytassa, ahol az
 * elozo abbahagyta, es a lista vegen korbeforduljon.
 */
import type { DiscoveredTarget } from '@radovin/contracts';

export interface RotationResult<T> {
  /** A feldolgozando lista, a folytatasi pontrol indulva. */
  targets: T[];
  /** Hanyadik elemnel folytattuk. 0 = az elejerol. */
  startIndex: number;
  /** Igaz, ha volt folytatasi pont, de az mar nem szerepel a listaban. */
  resumePointLost: boolean;
}

/**
 * A cellista elforgatasa a folytatasi ponthoz.
 *
 * A folytatasi pontot URL-kent taroljuk, nem indexkent. A cellista ket futas
 * kozott valtozhat - uj termek kerul be, regi kikerul -, es egy eltolodott
 * index nema atugrast okozna: a katalogus egy szelete soha nem kerulne sorra,
 * es ez semmilyen naploban nem latszana.
 *
 * Ha a folytatasi URL mar nincs a listaban (pl. a termek eltunt a boltbol),
 * az elejerol kezdunk, es ezt jelezzuk. Ez tudatos dontes: inkabb dolgozzunk
 * fel valamit ketszer, mint hogy kihagyjunk egy szeletet.
 */
export function rotateToResumePoint<T extends { url: string }>(
  targets: readonly T[],
  resumeUrl: string | null | undefined,
): RotationResult<T> {
  if (!resumeUrl || targets.length === 0) {
    return { targets: [...targets], startIndex: 0, resumePointLost: false };
  }

  const found = targets.findIndex((t) => t.url === resumeUrl);
  if (found < 0) {
    return { targets: [...targets], startIndex: 0, resumePointLost: true };
  }
  if (found === 0) {
    return { targets: [...targets], startIndex: 0, resumePointLost: false };
  }

  return {
    targets: [...targets.slice(found), ...targets.slice(0, found)],
    startIndex: found,
    resumePointLost: false,
  };
}

/** Tipusrogzitett valtozat a felderitesi celokra. */
export function rotateTargets(
  targets: readonly DiscoveredTarget[],
  resumeUrl: string | null | undefined,
): RotationResult<DiscoveredTarget> {
  return rotateToResumePoint(targets, resumeUrl);
}
