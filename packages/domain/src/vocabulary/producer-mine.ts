/**
 * Boraszat-jeloltek banyaszasa a korpuszbol.
 *
 * A `producers` tabla ures, es a bor kategoriaban a `producer` KOTELEZO mezo -
 * amig nincs benne semmi, egyetlen borparositas sem tud sikerulni. Ez a modul
 * abbol keszit jelolteket, ami a slot-kitolteses felbontas utan MEGMARAD:
 * ha a fajtat, a bortipust, a borvideket, az evjaratot es a kiszerelest mar
 * levontuk, ami a nev elejen marad, az nagy esellyel a boraszat.
 *
 * Az elso meres tanulsaga: a puszta szogyakorisag hasznalhatatlan. A rangsor
 * tetejen a `whisky`, `eves`, `the`, `reserve` allt - kereskedelmi zaj es
 * tomenyital-szokincs. Harom dolog kellett hozza:
 *
 *   1. TERMELONEV-JELOLOK. A `chateau` nem zaj: a "Château Margaux" maga a
 *      pinceszet neve. Az ujlatin nyelvekben ez ELOTAG (Château, Domaine,
 *      Bodegas, Quinta, Tenuta, Weingut), a magyarban UTOTAG (Jásdi Pince,
 *      Gilvesy Pincészet, Takler Borbirtok). Mindketto kell.
 *   2. POZICIO. A boraszatnev a nev ELEJEN all; az `eves`, `the`, `extra`
 *      soha nem vezet.
 *   3. BOLTOK KOZTI TAMOGATOTTSAG. Egy magyar boraszat jellemzoen tobb boltban
 *      is ott van; egy kulfoldi tetel gyakran kizarolagos. A tobbboltos jelolt
 *      ezert erosebb - es ez egyben a magyar boraszatokat emeli ki.
 */
import { searchNorm } from '../normalization/text.js';

/**
 * Termelonev-ELOTAGOK. Ujlatin es germán nyelvteruleten a birtok neve a
 * jelolovel kezdodik, es maga a jelolo is a nev resze: a "Château Margaux"
 * termelo neve nem "Margaux", hanem "Château Margaux".
 */
const PREFIX_MARKERS = new Set([
  // francia
  'chateau', 'domaine', 'maison', 'clos', 'cave', 'caves', 'mas', 'closerie',
  // spanyol / portugal
  'bodega', 'bodegas', 'quinta', 'herdade', 'finca', 'vina', 'celler', 'casa',
  // olasz
  'tenuta', 'tenute', 'castello', 'cantina', 'cantine', 'podere', 'poderi',
  'fattoria', 'azienda', 'villa', 'ca',
  // nemet / osztrak
  'weingut', 'weinhaus', 'schloss',
]);

/**
 * Termelonev-UTOTAGOK. A magyarban a jelolo a nev vegen all, es szinten a nev
 * resze: a "Jásdi Pince" termelo neve nem "Jásdi", hanem "Jásdi Pince".
 */
const SUFFIX_MARKERS = new Set([
  'pince', 'pinceszet', 'boraszat', 'borbirtok', 'birtok', 'szolobirtok',
  'kuria', 'major', 'borhaz', 'pinceszete', 'csalad', 'fiai',
  'winery', 'estate', 'vineyard', 'vineyards', 'cellars', 'cellar',
]);

/**
 * Kereskedelmi es minositesi zaj. Ezek soha nem boraszatnevek, viszont
 * gyakran a nev elejen allnak vagy a maradekban ragadnak.
 *
 * Szandekosan NEM szerepel itt a `chateau`, `domaine`, `quinta` - azok
 * termelonev-jelolok, nem zaj.
 */
const STOPWORDS = new Set([
  // kereskedelem
  'akcio', 'akcios', 'ajandek', 'ajandekutalvany', 'diszdoboz', 'diszdobozban',
  'csomag', 'valogatas', 'valogatott', 'szett', 'karton', 'uj', 'ujdonsag',
  'kedvenc', 'ajanlat', 'ajanlott', 'top', 'best', 'sale', 'outlet',
  // minosites
  'premium', 'reserve', 'reserva', 'riserva', 'special', 'selection', 'limited',
  'edition', 'classic', 'grand', 'gran', 'superior', 'extra', 'imperial',
  'royal', 'exclusive', 'prestige', 'vintage', 'old', 'fine', 'rare',
  // tomeny-szokincs (a tomeny boltok zaja)
  'whisky', 'whiskey', 'rum', 'gin', 'vodka', 'tequila', 'cognac', 'brandy',
  'likor', 'palinka', 'sake', 'mezcal', 'bourbon', 'scotch', 'malt', 'single',
  'blended', 'cask', 'barrel', 'oak', 'distillery', 'proof',
  // altalanos
  'the', 'and', 'with', 'von', 'van', 'del', 'della', 'des', 'les', 'la', 'le',
  'eves', 'ev', 'years', 'year', 'anos', 'ans', 'db', 'liter', 'bor', 'wine',
  'organic', 'bio', 'natur', 'natural', 'mini', 'nagy', 'kis', 'big',
]);

/** Gyakori magyar keresztnevek - a szemelynev-alapu pinceszetek felismeresehez. */
const HU_FIRST_NAMES = new Set([
  'attila', 'andras', 'andrea', 'anna', 'antal', 'arpad', 'balazs', 'bela',
  'bence', 'csaba', 'daniel', 'david', 'dezso', 'endre', 'erik', 'erzsebet',
  'ferenc', 'frigyes', 'gabor', 'gabriella', 'gergely', 'geza', 'gyorgy',
  'gyula', 'imre', 'istvan', 'ivan', 'janos', 'jozsef', 'judit', 'julia',
  'kalman', 'karoly', 'katalin', 'krisztian', 'laszlo', 'lajos', 'levente',
  'lorinc', 'marton', 'maria', 'mihaly', 'miklos', 'norbert', 'otto', 'pal',
  'peter', 'robert', 'sandor', 'stephanie', 'szabolcs', 'tamas', 'tibor',
  'tivadar', 'viktor', 'vilmos', 'zoltan', 'zsolt', 'zsuzsanna', 'akos',
  'adam', 'aron', 'barnabas', 'donat', 'elemer', 'gaspar', 'hunor', 'kristof',
  'marcell', 'mate', 'olivier', 'richard', 'roland', 'sarolta', 'tas', 'vince',
]);

/**
 * Kotoszok es nevelok. Ezek a nev BELSEJEBEN ervenyesek ("Château de Sales",
 * "Tenuta dell'Ornellaia"), a SZELEN viszont csonka nevet jeleznek.
 *
 * A valos meresben ez adta a legtobb szemetet: a "chateau de" 42 elofordulassal
 * es 4 bolttal a rangsor elejere kerult, mert MINDEN "Château de X" bor
 * beleszamolt - holott ez nem egy boraszat neve, hanem egy nevtoredek.
 */
const CONNECTORS = new Set([
  'de', 'du', 'des', 'da', 'do', 'della', 'dell', 'del', 'di', 'dei',
  'la', 'le', 'les', 'los', 'las', 'el', 'il', 'al', 'au', 'aux', 'a', 'd',
  'es', 'and', 'und', 'von', 'van', 'zu', 'of', 'y', 'e', 'i',
]);

const NUMERIC_RE = /^[\d.,%]+$/;

export interface MineInput {
  shopKey: string;
  /** A nyers terméknev - bizonyitekhoz. */
  rawName: string;
  /**
   * A slot-kitoltes utan MEGMARADT tokenek, EREDETI SORRENDBEN. Ebbol mar
   * hianyzik a fajta, a bortipus, a borvidek, az evjarat es a kiszereles.
   */
  residueTokens: readonly string[];
}

export interface ProducerCandidate {
  /** A jelolt neve, normalizalt alakban. */
  name: string;
  /** Hany listingen fordult elo. */
  count: number;
  /** Hany kulonbozo boltban. */
  shops: number;
  /** A nev elejen allt-e (hany esetben). */
  leadingCount: number;
  /** Termelonev-jelolot tartalmaz-e (Château, Pince, Weingut, ...). */
  hasMarker: boolean;
  /** Magyar szemelynev-mintara illik-e (Vezeteknev Keresztnev). */
  personName: boolean;
  score: number;
  /** Nehany pelda a nyers nevekbol - a jovahagyashoz. */
  examples: string[];
}

export interface MineOptions {
  /** Legalabb hany listingen kell elofordulnia. Alap: 3. */
  minCount?: number;
  /** Legalabb hany boltban. Alap: 2 - ez emeli ki a magyar boraszatokat. */
  minShops?: number;
  /** Legfeljebb hany jelolt keruljon a kimenetbe. Alap: 300. */
  limit?: number;
}

interface Acc {
  count: number;
  shops: Set<string>;
  leadingCount: number;
  hasMarker: boolean;
  examples: string[];
}

function isNoise(token: string): boolean {
  return !token || token.length < 2 || NUMERIC_RE.test(token) || STOPWORDS.has(token);
}

/**
 * Magyar szemelynev-e? Ket token, a masodik ismert keresztnev.
 *
 * Ez nem kozmetika: a szemelynev-alapu pinceszeteknel a fuzzy egyezes TILOS
 * (spec 13.3). A "Gere Attila" es a "Gere Zsolt" ket kulon boraszat, a
 * trigram-hasonlosaguk viszont magas.
 */
export function looksLikeHungarianPersonName(name: string): boolean {
  const parts = (searchNorm(name) ?? '').split(' ').filter(Boolean);
  if (parts.length !== 2) return false;
  return HU_FIRST_NAMES.has(parts[1]!) && !HU_FIRST_NAMES.has(parts[0]!);
}

/**
 * Jelolt-n-gramok egy maradekbol.
 *
 * Harom forrasbol gyujtunk:
 *   - a maradek ELEJEROL 1-3 tokenes n-gramok (a boraszat jellemzoen vezet);
 *   - ELOTAG-jelolotol indulo 2-3 tokenes n-gramok (Château Margaux);
 *   - UTOTAG-jelolore vegzodo 2-3 tokenes n-gramok (Jásdi Pince).
 */
function candidatesFrom(tokens: readonly string[]): Array<{ name: string; leading: boolean; marker: boolean }> {
  // Nevenkent EGY bejegyzes, de a jelzoket OSSZEVONVA. Ugyanaz a nev
  // keletkezhet a vezeto n-gram agrol (jelolo nelkul) es a jelolo-agrol is;
  // ha egyszeruen kihagynank a masodikat, a "Château Margaux" elvesztene a
  // sajat bizonyitekat, es tobbboltos tamogatas hijan kiesne a rangsorbol.
  const found = new Map<string, { leading: boolean; marker: boolean }>();
  const push = (parts: readonly string[], leading: boolean, marker: boolean) => {
    if (!parts.length) return;
    const first = parts[0]!;
    const last = parts[parts.length - 1]!;

    // Az elso token nem lehet zaj - azzal boraszatnev nem kezdodik.
    if (isNoise(first)) return;
    // Szam sehol a nevben.
    if (parts.some((p) => NUMERIC_RE.test(p))) return;
    // Kotoszo a SZELEN csonka nevet jelez: "chateau de", "es pinceszet".
    if (CONNECTORS.has(first) || CONNECTORS.has(last)) return;
    // Csupa jelolo es kotoszo nem nev: a puszta "chateau" 415 elofordulassal
    // vezette a rangsort, holott onmagaban semmit nem azonosit.
    if (parts.every((p) => PREFIX_MARKERS.has(p) || SUFFIX_MARKERS.has(p) || CONNECTORS.has(p))) return;
    const name = parts.join(' ');
    const prev = found.get(name);
    found.set(name, {
      leading: (prev?.leading ?? false) || leading,
      marker: (prev?.marker ?? false) || marker,
    });
  };

  for (let n = 1; n <= 3; n++) {
    if (tokens.length >= n) push(tokens.slice(0, n), true, false);
  }

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (PREFIX_MARKERS.has(t)) {
      for (let n = 2; n <= 4; n++) {
        if (i + n <= tokens.length) push(tokens.slice(i, i + n), i === 0, true);
      }
    }
    if (SUFFIX_MARKERS.has(t)) {
      for (let n = 2; n <= 4; n++) {
        if (i - n + 1 >= 0) push(tokens.slice(i - n + 1, i + 1), i - n + 1 === 0, true);
      }
    }
  }
  return [...found].map(([name, f]) => ({ name, leading: f.leading, marker: f.marker }));
}

/**
 * Boraszat-jeloltek rangsora a korpuszbol.
 *
 * A kimenet JAVASLAT: emberi jovahagyas nelkul semmi nem kerul a `producers`
 * tablaba. A pontszam csak a sorrendet adja, nem dontest.
 */
export function mineProducerCandidates(
  inputs: readonly MineInput[],
  opts: MineOptions = {},
): ProducerCandidate[] {
  const minCount = opts.minCount ?? 3;
  const minShops = opts.minShops ?? 2;
  const limit = opts.limit ?? 300;

  const acc = new Map<string, Acc>();
  for (const input of inputs) {
    const tokens = input.residueTokens.filter(Boolean);
    if (!tokens.length) continue;
    for (const cand of candidatesFrom(tokens)) {
      const a = acc.get(cand.name) ?? {
        count: 0, shops: new Set<string>(), leadingCount: 0, hasMarker: false, examples: [],
      };
      a.count++;
      a.shops.add(input.shopKey);
      if (cand.leading) a.leadingCount++;
      if (cand.marker) a.hasMarker = true;
      if (a.examples.length < 3 && !a.examples.includes(input.rawName)) {
        a.examples.push(input.rawName);
      }
      acc.set(cand.name, a);
    }
  }

  const out: ProducerCandidate[] = [];
  for (const [name, a] of acc) {
    if (a.count < minCount) continue;
    // A jelolonel nem varunk tobbboltos tamogatast: a "Château X" onmagaban
    // is bizonyitek, meg ha csak egy bolt arulja is.
    if (!a.hasMarker && a.shops.size < minShops) continue;

    const personName = looksLikeHungarianPersonName(name);
    const leadingRatio = a.count > 0 ? a.leadingCount / a.count : 0;

    const score =
      (a.hasMarker ? 5 : 0) +
      Math.min(a.shops.size, 5) * 1.5 +
      Math.log10(a.count + 1) * 1.5 +
      leadingRatio * 2 +
      (personName ? 1.5 : 0);

    out.push({
      name, count: a.count, shops: a.shops.size,
      leadingCount: a.leadingCount, hasMarker: a.hasMarker,
      personName, score: Math.round(score * 100) / 100,
      examples: a.examples,
    });
  }

  out.sort((x, y) => y.score - x.score || y.count - x.count || x.name.localeCompare(y.name));
  return out.slice(0, limit);
}
