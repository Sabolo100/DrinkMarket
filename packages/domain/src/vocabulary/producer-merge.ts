/**
 * Ugyanannak a boraszatnak a TOBBSZOROS jelöltjei - felismeres es csoportositas.
 *
 * A banyaszat n-gramokbol dolgozik, es ugyanarrol a pinceszetrol tobb jeloltet
 * is elohoz: a "Sauska Brut", a "Sauska Extra Dry" es a "Sauska Puttonyos"
 * harom kulon sor lesz, holott egyetlen boraszat. Ugyanigy all elo a "Bock" es
 * a "Bock Pince" parban - a masodik csak a magyar utotag-jelolovel bovebb.
 *
 * Ez nem kozmetikai gond. Amig harom kulon `producer` sor letezik, a harom bor
 * HAROM kulon termelohoz tartozik, es a parositas soha nem tudja osszekotni
 * oket - a `producer` a bor kategoriaban kotelezo azonossagmezo.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * Amit ez a modul NEM tesz: nem von ossze semmit.
 *
 * A "Gere Attila" es a "Gere Zsolt" ket kulon boraszat, a vezeto tokenjuk
 * megis azonos (spec 13.3). Egy automatikus osszevonas ket valodi pinceszetet
 * olvasztana egybe, es ezt utolag szetvalasztani draga. Ezert a modul CSAK
 * javaslatot ad, bizonyitekkal es bizonyossagi fokkal; a dontes emberi.
 */
import { searchNorm } from '../normalization/text.js';

/**
 * Termelonev-jelolok. Ugyanaz a ket keszlet, mint a banyaszatban, de itt
 * MAS a szerepuk: ott a nev RESZEI ("Jásdi Pince" a teljes nev), itt a
 * csoportkulcs kepzesekor LEVAGJUK oket, hogy a "Bock" es a "Bock Pince"
 * egy csoportba kerulhessen.
 */
const SUFFIX_MARKERS = new Set([
  'pince', 'pinceszet', 'pinceszete', 'boraszat', 'boraszata', 'borbirtok',
  'birtok', 'szolobirtok', 'szoloszet', 'kuria', 'major', 'borhaz', 'csalad',
  'fiai', 'tarsa', 'winery', 'estate', 'vineyard', 'vineyards',
  'cellars', 'cellar', 'wines', 'wine',
]);

/** Cegformak. Sosem reszei a boraszat azonossaganak. */
const LEGAL_FORMS = new Set([
  'kft', 'zrt', 'bt', 'nyrt', 'kkt', 'gmbh', 'srl', 'spa', 'sarl',
  'ltd', 'llc', 'inc', 'bv', 'nv', 'ag',
]);

/**
 * ELOTAG-jelolok. Ezek a kulcs RESZEI maradnak: a "Château Margaux" es a
 * "Château Palmer" NEM ugyanaz a birtok, tehat a puszta "chateau" nem lehet
 * csoportkulcs.
 */
const PREFIX_MARKERS = new Set([
  'chateau', 'domaine', 'maison', 'clos', 'cave', 'caves', 'mas',
  'bodega', 'bodegas', 'quinta', 'herdade', 'finca', 'vina', 'celler', 'casa',
  'tenuta', 'tenute', 'castello', 'cantina', 'cantine', 'podere', 'poderi',
  'fattoria', 'azienda', 'villa', 'weingut', 'weinhaus', 'schloss',
]);

/**
 * Bor-szokincs, ami a banyaszat maradekaban ragadt es jeloltnev lett.
 *
 * A felhasznalo eppen ezt latta: "Sauska Extra Dry", "Sauska Brut",
 * "Sauska Puttonyos". A `brut`, a `dry` es a `puttonyos` nem a termelo neve,
 * hanem a bore - a csoportkulcsbol tehat ki kell esnie.
 */
const WINE_TERMS = new Set([
  // pezsgo
  'brut', 'extra', 'dry', 'sec', 'demi', 'doux', 'nature', 'zero', 'dosage',
  'blanc', 'blancs', 'noirs', 'cuvee', 'pezsgo', 'rose',
  // edesseg / aszu
  'puttonyos', 'puttony', 'aszu', 'szamorodni', 'edes', 'feledes', 'szaraz',
  'felszaraz', 'esszencia', 'forditas', 'maslas',
  // szin es tipus
  'voros', 'feher', 'siller', 'red', 'white',
  // minosites
  'premium', 'reserve', 'reserva', 'riserva', 'selection', 'valogatas',
  'limited', 'edition', 'grand', 'gran', 'classic', 'special', 'prestige',
  'birtokbor', 'dulo', 'vintage',
]);

/** Szamok, evjaratok, urtartalom. */
const NUMERIC_RE = /^[\d.,%]+$/;

/**
 * A normalizalas a mondatvegi pontot MEGTARTJA, ezert a "Kft." tokenje
 * `kft.` - az pedig nem illeszkedik a cegforma-listara. A kovetkezmenye nem
 * a hianyzo szures lenne, hanem egy rossz csoportositas: a "Bock Kft." es a
 * "Bock Pince" teljes kulcsa eltérne, es a par nem `prefix`-kent, hanem a
 * gyengebb `token` agon jelenne meg.
 */
function tokensOf(name: string): string[] {
  return (searchNorm(name) ?? '')
    .split(' ')
    .map((t) => t.replace(/^[.,;:'"-]+|[.,;:'"-]+$/g, ''))
    .filter(Boolean);
}

/**
 * A csoportkulcs: ami a nevbol MEGMARAD, ha levonjuk a jelolot, a cegformat,
 * a bor-szokincset es a szamokat.
 *
 * Egy tokenre rovidul a magyar tobbseg ("bock", "sauska", "thummerer"), es
 * ket-harom tokenre a jelolovel kezdodo ujlatin nevek ("chateau margaux").
 * Ures kulcs azt jelenti, hogy a nevben NEM maradt azonosito - az ilyen sor
 * nem csoportosithato, es nem is javaslunk ra semmit.
 */
export function producerMergeKey(name: string): string {
  const parts = tokensOf(name).filter(
    (t) => !SUFFIX_MARKERS.has(t) && !LEGAL_FORMS.has(t)
      && !WINE_TERMS.has(t) && !NUMERIC_RE.test(t) && t.length > 1,
  );
  if (!parts.length) return '';
  // Elotag-jelolo eseten KETTO token kell: a puszta "chateau" nem azonosit.
  if (PREFIX_MARKERS.has(parts[0]!)) {
    return parts.slice(0, 2).join(' ');
  }
  return parts[0]!;
}

/** Kulcs, amiben minden token benne van - a teljes-nev egyezes vizsgalatahoz. */
function fullKey(name: string): string {
  return tokensOf(name)
    .filter((t) => !SUFFIX_MARKERS.has(t) && !LEGAL_FORMS.has(t) && !NUMERIC_RE.test(t))
    .join(' ');
}

export interface MergeMember {
  id: string;
  canonicalName: string;
  status: string;
  /** Hany listing van mar hozzakotve. Az osszevonasnal ez a legfobb suly. */
  linkedListings: number;
  candidateScore: number | null;
  /** A banyaszat szemelynev-gyanuja. */
  personName: boolean;
  fuzzyBlocked: boolean;
}

export type MergeConfidence = 'high' | 'medium';

export interface MergeGroup {
  key: string;
  /** `prefix`: az egyik nev a masik roviditese. `token`: kozos vezeto token. */
  kind: 'prefix' | 'token';
  confidence: MergeConfidence;
  /** A javasolt tulelo. Csak javaslat - a felhasznalo felulirhatja. */
  suggestedKeepId: string;
  members: MergeMember[];
  /**
   * Miert kell ide emberi szem? Ures tomb = nincs kulon figyelmeztetes.
   * Sosem nemitjuk el a csoportot: a gyanu megjelenik, a dontes emberi.
   */
  warnings: string[];
}

/**
 * A javasolt tulelo kivalasztasa.
 *
 * A sorrend nem eszteticai. Egy MAR JOVAHAGYOTT boraszat hatalyba lepett: a
 * listingjei ra mutatnak, es egy masikba olvasztas azokat is atmozgatna. A
 * legtobb kotott listinggel rendelkezo sor megtartasa a legkevesebb mozgatas
 * - es a legkisebb kockazat.
 */
function pickSurvivor(members: readonly MergeMember[]): MergeMember {
  return [...members].sort((a, b) => {
    const act = Number(b.status === 'active') - Number(a.status === 'active');
    if (act) return act;
    if (b.linkedListings !== a.linkedListings) return b.linkedListings - a.linkedListings;
    // Azonos sulynal a ROVIDEBB nev nyer: a boraszat neve "Sauska", nem
    // "Sauska Extra Dry". A hosszabb valtozat a bor nevet is magaban hordja.
    const len = tokensOf(a.canonicalName).length - tokensOf(b.canonicalName).length;
    if (len) return len;
    return (b.candidateScore ?? 0) - (a.candidateScore ?? 0);
  })[0]!;
}

/**
 * Csoportok kepzese boraszatjeloltekbol.
 *
 * Ket csoportfajtat kulonboztetunk meg, mert a bizonyossaguk MAS:
 *
 *   - `prefix`  - az egyik nev a masik eleje ("Bock" ⊂ "Bock Pince"). Itt a
 *                 tevedes eselye kicsi: ket kulon pinceszet nevbol az egyik
 *                 ritkan a masik pontos kezdete.
 *   - `token`   - csak a vezeto token kozos ("Sauska Brut" ↔ "Sauska Extra
 *                 Dry"). Ez a gyakoribb es a zajosabb: ide esik a "Gere
 *                 Attila" ↔ "Gere Zsolt" par is.
 *
 * A `retired` es a mar `merged` sorok kimaradnak: azokrol mar szuletett
 * dontes, es egy javaslat nem birálhatja felul.
 */
export function groupMergeCandidates(rows: readonly MergeMember[]): MergeGroup[] {
  const byKey = new Map<string, MergeMember[]>();
  for (const r of rows) {
    if (r.status === 'merged' || r.status === 'retired') continue;
    const key = producerMergeKey(r.canonicalName);
    if (!key) continue;
    const list = byKey.get(key);
    if (list) list.push(r); else byKey.set(key, [r]);
  }

  const groups: MergeGroup[] = [];
  for (const [key, members] of byKey) {
    if (members.length < 2) continue;

    // Prefix-e a csoport? Akkor az, ha MINDEN tag teljes kulcsa ugyanazzal a
    // legrovidebb taggal kezdodik - vagyis a nevek egymas bovitesei.
    const fulls = members.map((m) => ({ full: fullKey(m.canonicalName) }));
    const shortest = [...fulls].sort((a, b) => a.full.length - b.full.length)[0]!;
    const isPrefix = fulls.every(
      (f) => f.full === shortest.full || f.full.startsWith(`${shortest.full} `),
    );

    const warnings: string[] = [];
    if (members.some((m) => m.personName || m.fuzzyBlocked)) {
      warnings.push(
        'Szemelynev-gyanu: a "Gere Attila" es a "Gere Zsolt" KET KULON boraszat. '
        + 'Ellenorizd a nevek teljes alakjat, mielott osszevonod.',
      );
    }
    const actives = members.filter((m) => m.status === 'active');
    if (actives.length > 1) {
      warnings.push(
        `${actives.length} tag mar jova van hagyva. Az osszevonas a listingjeiket `
        + 'atmozgatja a tulelore.',
      );
    }

    groups.push({
      key,
      kind: isPrefix ? 'prefix' : 'token',
      confidence: isPrefix && warnings.length === 0 ? 'high' : 'medium',
      suggestedKeepId: pickSurvivor(members).id,
      members: [...members].sort((a, b) => b.linkedListings - a.linkedListings),
      warnings,
    });
  }

  // A legtobb erintett listing elore: ott a legnagyobb a hozam dontesenkent.
  return groups.sort((a, b) => {
    const la = a.members.reduce((s, m) => s + m.linkedListings, 0);
    const lb = b.members.reduce((s, m) => s + m.linkedListings, 0);
    if (lb !== la) return lb - la;
    return b.members.length - a.members.length;
  });
}
