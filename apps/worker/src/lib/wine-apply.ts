/**
 * A bornev slotjainak visszairasa egy MAR BEGYUJTOTT listingre.
 *
 * Ez zarja be a kort a boraszat-jovahagyas es a katalogus kozott. A
 * `source_listings.producer_id` a jovahagyastol magatol nem tolodik ki: az
 * azonossagot a termek NEVEBOL nyerjuk ki, a nevhez viszont mar nem kell a
 * webshop - ott van a sorban. Ezert az ujrakinyereshez nem kell ujracrawl,
 * csak a friss szotar.
 *
 * Amit a nev hordoz, azt a parser hatarozza meg (fajta, tipus, dulo, vidék,
 * fantazianev); amit a kinyeres eros bizonyitekbol szerzett (evjarat a
 * spec-tablabol, szin a JSON-LD-bol), azt NEM irjuk felul. A ket forras
 * erossege kulonbozo, es a gyengebb nem nyerhet.
 */
import type { PoolClient } from 'pg';
import { identityHash, parseVolume, type WineParseResult } from '@radovin/domain';
import type { IdentityFields } from '@radovin/contracts';

/** A listing azon mezoi, amikbol az identitas-hash ujraszamolhato. */
export interface WineListingRow {
  id: string;
  raw_name: string;
  category_id: string | null;
  /** A jelenlegi besorolas KULCSA. A javitas ehhez merve dol el. */
  category_key: string | null;
  platform_product_id: string | null;
  platform_variant_id: string | null;
  producer_id: string | null;
  producer_name: string | null;
  brand_id: string | null;
  brand_name: string | null;
  expression: string | null;
  vintage_value: number | null;
  vintage_status: string;
  age_statement_years: number | null;
  volume_ml: number | null;
  pack_count: number;
  packaging_type: string;
  edition: string | null;
  cask_finish: string | null;
  dosage_style: string | null;
  puttony: number | null;
  gtin: string | null;
  colour: string | null;
  wine_style_id: string | null;
  vineyard_id: string | null;
  wine_region_id: string | null;
  grape_signature: string | null;
  grape_ids: string[] | null;
}

/** Szotari kiegeszito adat, amit a parser nem ad vissza. */
export interface WineLookups {
  /** wine_styles.id -> colour */
  styleColour: ReadonlyMap<string, string | null>;
  /** grape_varieties.id -> colour_default */
  grapeColour: ReadonlyMap<string, string | null>;
  /** wine_styles.id -> pezsgo-e a bortipus */
  styleSparkling?: ReadonlyMap<string, boolean>;
  /** wine_styles.id -> puttonyszam-relevans-e (aszu) */
  stylePuttony?: ReadonlyMap<string, boolean>;
  /**
   * `product_categories.key` -> id. Ha egy besorolatlan listing neve a
   * BORSZOTARBOL oldodott fel - van boraszata ES fajtaja vagy bortipusa -,
   * akkor bizonyitottan bor, es megkaphatja a kategoriat.
   *
   * Ez nem kozmetika: a kategoria hozza magaval az identitasprofilt. Az
   * `uncategorized` profil szerint az `expression` KOTELEZO mezo, a bor
   * szerint viszont csak ellentmondasjelzo - a fantazianev ugyanis
   * hianyozhat a bolti nevbol. Kategoria nelkul ezert minden borpar
   * "kotelezo tetel nem bizonyitott" indokkal allna meg.
   */
  categoryIdByKey?: ReadonlyMap<string, string>;
}

/**
 * MELYIK bor-kategoria?
 *
 * Korabban minden bizonyitott bor egyetlen, atalanyos `wine` kategoriat
 * kapott. Ez a kategoria-osszehasonlitast nem egyszeruen elnemitotta, hanem
 * HAMIS EGYEZESSE forditotta: a pezsgo es a szaraz voros egyarant `wine`
 * lett, tehat a mezo `match` allapotot adott rajuk.
 *
 * A valos kovetkezmenye lathato volt a feluleten: egy Sauska Brut Nature
 * pezsgo melle a rendszer Chardonnay-t, Furmintot es Syrah-t kinalt, mert az
 * egyetlen mezo, ami ezeket egy mozdulattal kizarna, egyetértett veluk.
 *
 * A `wine_styles.sparkling` es a `puttony_relevant` pontosan ezt a
 * kulonbseget mondja ki - csak eddig senki nem kerdezte meg oket.
 *
 * A javitas KETIRANYU, es ez fontos:
 *
 *   - besorolatlan sor megkapja a helyes kategoriat;
 *   - a korabban atalanyosan `wine`-ra allitott sor JAVITHATO, ha a bortipus
 *     bizonyitja, hogy pezsgo vagy aszu.
 *
 * A masodik nelkul a mar eltárolt hibas besorolas orokre bennmaradna, es a
 * javitas csak az ezutan begyujtott sorokra hatna. Bovitesnel viszont
 * szigoruak vagyunk: kizarolag a `wine` irhato felul, es kizarolag pozitiv
 * bizonyitek alapjan. Barmely mas kategoriat (tomeny, kezi besorolas)
 * erintetlenul hagyunk.
 */
export function wineCategoryFor(
  parsed: WineParseResult,
  lookups: WineLookups,
  currentCategoryKey: string | null,
): string | null {
  const styleId = parsed.style?.id ?? null;
  const sparkling = styleId ? lookups.styleSparkling?.get(styleId) === true : false;
  const aszu = styleId ? lookups.stylePuttony?.get(styleId) === true : false;

  const key = sparkling ? 'sparkling_wine' : aszu ? 'tokaji_aszu' : 'wine';
  const id = lookups.categoryIdByKey?.get(key) ?? null;

  // Nincs besorolas: csak bizonyitott bornal adunk egyet.
  if (currentCategoryKey === null) {
    return provenWine(parsed) ? id : null;
  }
  // Van besorolas. Csak az atalanyos `wine`-t javitjuk, es csak akkor, ha a
  // bortipus POZITIVAN mast mond.
  if (currentCategoryKey === 'wine' && key !== 'wine') return id;
  return null;
}

/** Kimondta-e mar valaki, hogy evjaratos-e a tetel? */
function isVintageStated(status: string | null | undefined): status is string {
  return status === 'vintage' || status === 'non_vintage' || status === 'not_applicable';
}

/** Bizonyitott-e, hogy ez a sor bor? Boraszat onmagaban nem eleg. */
function provenWine(parsed: WineParseResult): boolean {
  return Boolean(parsed.producer) && (parsed.grapes.length > 0 || parsed.style !== null);
}

export interface ApplyResult {
  changed: boolean;
  /** Mely mezok kaptak uj erteket - a naplozashoz es a riporthoz. */
  fields: string[];
  identityHash: string;
}

/** Ket id-halmaz azonos-e, sorrendtol fuggetlenul. */
function sameIdSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const x = [...a].sort();
  const y = [...b].sort();
  return x.every((v, i) => v === y[i]);
}

/**
 * A szin levezetese: eloszor a bortipus mondja ki, utana a fajtak
 * alapertelmezese - de KIZAROLAG akkor, ha MINDEN fajta szinet ismerjuk es
 * mind ugyanazt mondja. Egy cuvee-nel a "kek + feher" nem ad rose-t, hanem
 * semmit: a nem tudjuk jobb, mint a rossz valasz.
 */
function deriveColour(parsed: WineParseResult, lookups: WineLookups): string | null {
  if (parsed.style) {
    const c = lookups.styleColour.get(parsed.style.id);
    if (c) return c;
  }
  if (!parsed.grapes.length) return null;
  const colours = parsed.grapes.map((g) => lookups.grapeColour.get(g.id) ?? null);
  if (colours.some((c) => c === null)) return null;
  const distinct = new Set(colours);
  return distinct.size === 1 ? (colours[0] ?? null) : null;
}

/** A nevbol kiolvasott slotok, a forraserossegi szabalyok mar ervenyesitve. */
export interface WineSlotPatch {
  producerId: string | null;
  producerName: string | null;
  wineStyleId: string | null;
  wineStyleName: string | null;
  vineyardId: string | null;
  vineyardName: string | null;
  wineRegionId: string | null;
  wineRegionName: string | null;
  grapeIds: string[];
  grapeNames: string[];
  expression: string | null;
  vintageValue: number | null;
  vintageStatus: string;
  colour: string | null;
  volumeMl: number | null;
  packCount: number;
}

/**
 * A slotok osszefesulese a mar ismert ertekekkel - EGY helyen.
 *
 * Ket ut vezet ide: a begyujtes (`persistListing`) es az ujrakinyeres
 * (`applyWineIdentity`). Ha a ket ut mas eredmenyt adna ugyanarra a nevre,
 * akkor minden begyujtes ELSODRODASNAK latna a sajat korabbi munkajat, es
 * megallitana az arak publikalasat. Ezert a szabalyok itt laknak, kozosen.
 */
export function wineSlotPatch(
  parsed: WineParseResult,
  prior: {
    producerId?: string | null; producerName?: string | null;
    vintageValue?: number | null; vintageStatus?: string | null;
    colour?: string | null;
    rawName?: string | null;
    volumeMl?: number | null; packCount?: number | null;
  },
  lookups: WineLookups,
): WineSlotPatch {
  const vintageValue = prior.vintageValue ?? parsed.vintageValue;

  // A kiszereles a leghianyosabb azonossagmezo: a valos korpusz felen sincs
  // meg. A nevben viszont majdnem mindig ott van ("0,75 l", "75cl"), es a
  // rendszernek mar van ra elemzoje - csak eddig kizarolag a begyujtes
  // futtatta, az ujrakinyeres nem.
  //
  // Ugyanaz a forraserossegi szabaly: a spec-tablabol kinyert ertek
  // erosebb, ezert csak a HIANYT toltjuk ki.
  const fromName = prior.volumeMl == null || (prior.packCount ?? 1) <= 1
    ? parseVolume(prior.rawName ?? null)
    : null;
  const volumeMl = prior.volumeMl ?? fromName?.unitVolumeMl ?? null;
  // A darabszamnal a `null` es az `1` nem kulonboztetheto meg (az oszlop
  // alapertelmezese 1), ezert CSAK a bizonyitott tobbes csomagot irjuk be.
  // Ez a biztonsagos irany: egy 6-os karton igy nem parosodhat egy palackkal.
  const packCount = (fromName && fromName.packCount > 1)
    ? fromName.packCount
    : (prior.packCount ?? 1);
  return {
    // A boraszatot nem vesszuk el: ha a nev most nem adja ki, a korabban
    // feloldott ertek marad ervenyben.
    producerId: parsed.producer?.id ?? prior.producerId ?? null,
    producerName: parsed.producer?.canonicalName ?? prior.producerName ?? null,
    // A tobbi nevbol szarmazo slotnal a parser a hatosag - a null is ervenyes
    // uj ertek, mert egy elavult szotartalalat TEVES adat.
    wineStyleId: parsed.style?.id ?? null,
    wineStyleName: parsed.style?.canonicalName ?? null,
    vineyardId: parsed.vineyard?.id ?? null,
    vineyardName: parsed.vineyard?.canonicalName ?? null,
    wineRegionId: parsed.region?.id ?? null,
    wineRegionName: parsed.region?.canonicalName ?? null,
    grapeIds: parsed.grapes.map((g) => g.id),
    grapeNames: parsed.grapes.map((g) => g.canonicalName),
    expression: parsed.expression,
    // Az evjarat es a szin csak akkor jon a nevbol, ha eddig NEM tudtuk. A
    // spec-tablabol vagy JSON-LD-bol kinyert ertek erosebb bizonyitek.
    vintageValue,
    // Az evjarat ALLAPOTA kulon mezo, es a parosito ezt nezi: amig `unknown`,
    // addig a szam maga nem szamit bizonyitottnak. A bor profilja szerint az
    // evjarat KOTELEZO - vagyis allapot nelkul MINDEN borpar
    // "kotelezo evjarat nem bizonyitott" indokkal allna meg. Ha a nevben ott
    // az evszam, akkor ez evjaratos bor; ezt ki kell mondani.
    vintageStatus: isVintageStated(prior.vintageStatus)
      ? prior.vintageStatus
      : (vintageValue !== null ? 'vintage' : (prior.vintageStatus ?? 'unknown')),
    colour: prior.colour ?? deriveColour(parsed, lookups),
    volumeMl,
    packCount,
  };
}

/**
 * A parser eredmenyenek beirasa. Egy tranzakcion belul hivando.
 *
 * A visszateres `changed = false`, ha a sor mar pontosan igy nezett ki -
 * ilyenkor sem UPDATE, sem klaszterezes nem indul. Ez teszi ismetelhetove:
 * ugyanaz a futas masodszorra nem csinal semmit, es nem araszt el a
 * sorbaallitas a klaszterezo queue-t.
 */
export async function applyWineIdentity(
  client: PoolClient,
  row: WineListingRow,
  parsed: WineParseResult,
  lookups: WineLookups,
): Promise<ApplyResult> {
  const fields: string[] = [];
  const patch = wineSlotPatch(parsed, {
    producerId: row.producer_id, producerName: row.producer_name,
    vintageValue: row.vintage_value, vintageStatus: row.vintage_status,
    colour: row.colour, rawName: row.raw_name,
    volumeMl: row.volume_ml, packCount: row.pack_count,
  }, lookups);

  const { producerId, wineStyleId: styleId, vineyardId, wineRegionId: regionId,
    grapeIds, expression, vintageValue: vintage, vintageStatus, colour,
    volumeMl, packCount } = patch;

  if (parsed.producer && parsed.producer.id !== row.producer_id) fields.push('producer_id');
  if (styleId !== row.wine_style_id) fields.push('wine_style_id');
  if (vineyardId !== row.vineyard_id) fields.push('vineyard_id');
  if (regionId !== row.wine_region_id) fields.push('wine_region_id');
  const grapesChanged = !sameIdSet(grapeIds, row.grape_ids ?? []);
  if (grapesChanged) fields.push('grape_varieties');
  if (expression !== row.expression) fields.push('expression');
  if (vintage !== row.vintage_value) fields.push('vintage_value');
  if (vintageStatus !== row.vintage_status) fields.push('vintage_status');
  if (colour !== row.colour) fields.push('colour');
  if (volumeMl !== row.volume_ml) fields.push('volume_ml');
  if (packCount !== (row.pack_count ?? 1)) fields.push('pack_count');

  // A kategoria javitasa. Lehet uj besorolas (eddig nem volt), es lehet a
  // korabbi atalanyos `wine` HELYESBITESE pezsgore vagy aszura.
  const newCategoryId = wineCategoryFor(parsed, lookups, row.category_key);
  const categoryId = newCategoryId ?? row.category_id ?? null;
  if (categoryId !== (row.category_id ?? null)) fields.push('category_id');

  if (!fields.length) {
    return { changed: false, fields, identityHash: '' };
  }

  // A fajta-kapcsolotabla ujrairasa. A lenyomatot utana az adatbazis adja:
  // egyetlen forras, hogy a TS es az SQL ne terhessen el egymastol.
  if (grapesChanged) {
    await client.query('DELETE FROM source_listing_grapes WHERE source_listing_id = $1', [row.id]);
    for (const [pos, g] of parsed.grapes.entries()) {
      await client.query(
        `INSERT INTO source_listing_grapes (source_listing_id, grape_variety_id, position, evidence)
         VALUES ($1, $2, $3, $4::jsonb)
         ON CONFLICT (source_listing_id, grape_variety_id) DO NOTHING`,
        [row.id, g.id, pos + 1, JSON.stringify({
          method: 'name_slot', matchedText: g.matchedText, viaAlias: g.viaAlias,
        })],
      );
    }
  }

  const sig = await client.query<{ signature: string | null }>(
    'SELECT rv_grape_signature($1::uuid[]) AS signature', [grapeIds],
  );
  const grapeSignature = sig.rows[0]?.signature ?? null;

  const identity: IdentityFields = {
    categoryKey: null,
    producer: patch.producerName,
    producerId,
    brand: row.brand_name, brandId: row.brand_id,
    expression,
    vintageValue: vintage,
    vintageStatus: vintageStatus as IdentityFields['vintageStatus'],
    ageStatementYears: row.age_statement_years,
    volumeMl,
    packCount,
    packagingType: row.packaging_type as IdentityFields['packagingType'],
    containerType: null,
    edition: row.edition, caskFinish: row.cask_finish, dosageStyle: row.dosage_style,
    sweetness: null, puttony: row.puttony, abvPercent: null,
    colour, region: patch.wineRegionName, countryCode: null,
    grapeVarieties: patch.grapeNames,
    gtin: row.gtin, sku: null, flavour: null, fruit: null, aging: null,
    subcategory: null, appellation: null,
    vineyard: patch.vineyardName, organic: null,
    grapeVarietyIds: grapeIds,
    grapeSignature,
    wineStyleId: styleId, wineStyle: patch.wineStyleName,
    vineyardId, wineRegionId: regionId,
  };

  const hash = identityHash({
    platformProductId: row.platform_product_id,
    platformVariantId: row.platform_variant_id,
    identity,
  });

  await client.query(
    `UPDATE source_listings SET
       producer_id     = $2,
       wine_style_id   = $3,
       vineyard_id     = $4,
       wine_region_id  = $5,
       grape_signature = $6,
       grape_varieties = $7,
       expression      = $8,
       vintage_value   = $9,
       vintage_status  = $13,
       volume_ml       = $14,
       pack_count      = $15,
       colour          = coalesce($10, colour),
       identity_hash   = $11,
       -- Nem coalesce: a helyesbitesnek felul KELL irnia a korabbi
       -- atalanyos wine besorolast, kulonben a mar eltarolt hiba orokre
       -- bennmaradna. A wineCategoryFor gondoskodik rola, hogy ez csak
       -- pozitiv bizonyitek mellett tortenjen.
       category_id     = $12::uuid,
       -- Az azonossag megvaltozott, tehat a korabbi "megneztuk, nem talaltunk"
       -- dontes ervenyet vesztette. A mar OSSZEPAROSITOTT sorhoz nem nyulunk:
       -- azt ember hagyta jova, es a felulvizsgalat kulon dontes.
       cluster_status  = CASE WHEN cluster_status = 'clustered' THEN cluster_status
                              ELSE 'unclustered' END,
       updated_at      = now()
     WHERE id = $1`,
    [
      row.id, producerId, styleId, vineyardId, regionId,
      grapeSignature, identity.grapeVarieties,
      expression, vintage, colour, hash, categoryId, vintageStatus,
      volumeMl, packCount,
    ],
  );

  return { changed: true, fields, identityHash: hash };
}
