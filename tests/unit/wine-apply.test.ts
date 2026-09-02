/**
 * A jovahagyott boraszat visszavezetese a mar begyujtott listingekre.
 *
 * Ket dolog dolt el itt, es mindketto konnyen elromlik csendben:
 *
 *   1. ISMETELHETOSEG. Az ujrakinyeres ugyanarra a sorra ketszer lefuttatva
 *      masodszorra nem csinalhat semmit. Ha megis ir, akkor minden futas
 *      ujra sorba allitja az OSSZES listinget klaszterezesre - egy jovahagyas
 *      husz masodperccel kesobb elarasztana a queue-t.
 *   2. FORRASEROSSEG. A nevbol olvasott evjarat es szin GYENGEBB bizonyitek,
 *      mint a spec-tablabol vagy a JSON-LD-bol kinyert - a gyengebb nem
 *      irhatja felul az erosebbet.
 */
import { describe, it, expect } from 'vitest';
import type { PoolClient } from 'pg';
import type { SlotMatch, WineParseResult } from '@radovin/domain';
import {
  applyWineIdentity, type WineListingRow, type WineLookups,
} from '../../apps/worker/src/lib/wine-apply.js';

const STYLE_RED = 'style-red';
const STYLE_ROSE = 'style-rose';
const GRAPE_KEK = 'grape-kekfrankos';
const GRAPE_OLASZ = 'grape-olaszrizling';

const WINE_CATEGORY = 'cat-wine';

const lookups: WineLookups = {
  styleColour: new Map([[STYLE_RED, 'red'], [STYLE_ROSE, 'rose'], ['style-unknown', null]]),
  grapeColour: new Map([
    [GRAPE_KEK, 'red'], [GRAPE_OLASZ, 'white'], ['grape-nocolour', null],
  ]),
  wineCategoryId: WINE_CATEGORY,
};

/** A tenyleges SQL-t nem futtatjuk; azt figyeljuk, MIT akart irni. */
function fakeClient() {
  const calls: Array<{ sql: string; params: readonly unknown[] }> = [];
  const client = {
    query: async (sql: string, params: readonly unknown[] = []) => {
      calls.push({ sql, params });
      if (sql.includes('rv_grape_signature')) {
        const ids = (params[0] as string[]) ?? [];
        return { rows: [{ signature: ids.length ? [...ids].sort().join('+') : null }] };
      }
      return { rows: [] };
    },
  };
  return {
    client: client as unknown as PoolClient,
    calls,
    updates: () => calls.filter((c) => c.sql.includes('UPDATE source_listings')),
    grapeDeletes: () => calls.filter((c) => c.sql.includes('DELETE FROM source_listing_grapes')),
    grapeInserts: () => calls.filter((c) => c.sql.includes('INSERT INTO source_listing_grapes')),
  };
}

function match(slot: SlotMatch['slot'], id: string, name: string): SlotMatch {
  return {
    slot, id, canonicalName: name, matchedText: name.toLowerCase(),
    viaAlias: null, startToken: 0, tokenCount: 1,
  };
}

function parse(over: Partial<WineParseResult> = {}): WineParseResult {
  return {
    producer: null, vineyard: null, region: null, style: null, grapes: [],
    vintageValue: null, expression: null, matches: [], ambiguous: [], tokens: [],
    ...over,
  };
}

function row(over: Partial<WineListingRow> = {}): WineListingRow {
  return {
    id: 'listing-1', raw_name: 'Sauska Kékfrankos 2019', category_id: null,
    platform_product_id: 'p1', platform_variant_id: null,
    producer_id: null, producer_name: null, brand_id: null, brand_name: null,
    expression: null, vintage_value: null, vintage_status: 'unknown',
    age_statement_years: null, volume_ml: 750, pack_count: 1,
    packaging_type: 'bottle', edition: null, cask_finish: null, dosage_style: null,
    puttony: null, gtin: null, colour: null,
    wine_style_id: null, vineyard_id: null, wine_region_id: null,
    grape_signature: null, grape_ids: null,
    ...over,
  };
}

describe('ismetelhetoseg', () => {
  it('a mar felismert sorra masodszor NEM ir', async () => {
    // Ez a legfontosabb allitas: enelkul minden futas ujra sorba allitana az
    // osszes listinget klaszterezesre.
    const f = fakeClient();
    const result = await applyWineIdentity(
      f.client,
      row({
        producer_id: 'prod-sauska', wine_style_id: null, vineyard_id: null,
        wine_region_id: null, grape_ids: [GRAPE_KEK], expression: null,
        vintage_value: 2019, vintage_status: 'vintage',
        colour: 'red', category_id: WINE_CATEGORY,
      }),
      parse({
        producer: match('producer', 'prod-sauska', 'Sauska'),
        grapes: [match('grape', GRAPE_KEK, 'Kékfrankos')],
        vintageValue: 2019,
      }),
      lookups,
    );
    expect(result.changed).toBe(false);
    expect(f.updates()).toHaveLength(0);
  });

  it('a fajtak SORRENDJE nem valtozas', async () => {
    const f = fakeClient();
    const result = await applyWineIdentity(
      f.client,
      row({
        producer_id: 'prod-sauska', grape_ids: [GRAPE_OLASZ, GRAPE_KEK],
        vintage_value: 2019, vintage_status: 'vintage',
        colour: 'red', category_id: WINE_CATEGORY,
      }),
      parse({
        producer: match('producer', 'prod-sauska', 'Sauska'),
        grapes: [match('grape', GRAPE_KEK, 'Kékfrankos'), match('grape', GRAPE_OLASZ, 'Olaszrizling')],
        vintageValue: 2019,
      }),
      lookups,
    );
    expect(result.changed).toBe(false);
    expect(f.grapeDeletes()).toHaveLength(0);
  });
});

describe('a boraszat felismerese', () => {
  it('kitolti a termelot, es ujraszamolja az identitas-hasht', async () => {
    const f = fakeClient();
    const result = await applyWineIdentity(
      f.client,
      row(),
      parse({
        producer: match('producer', 'prod-sauska', 'Sauska'),
        grapes: [match('grape', GRAPE_KEK, 'Kékfrankos')],
        vintageValue: 2019,
      }),
      lookups,
    );
    expect(result.changed).toBe(true);
    expect(result.fields).toContain('producer_id');
    expect(result.identityHash).toMatch(/^[0-9a-f]{40}$/);
    expect(f.updates()).toHaveLength(1);
    expect(f.updates()[0]?.params[1]).toBe('prod-sauska');
  });

  it('a fajtahalmaz valtozasakor ujrairja a kapcsolotablat', async () => {
    const f = fakeClient();
    await applyWineIdentity(
      f.client,
      row({ producer_id: 'prod-sauska', grape_ids: [GRAPE_OLASZ] }),
      parse({
        producer: match('producer', 'prod-sauska', 'Sauska'),
        grapes: [match('grape', GRAPE_KEK, 'Kékfrankos')],
      }),
      lookups,
    );
    expect(f.grapeDeletes()).toHaveLength(1);
    expect(f.grapeInserts()).toHaveLength(1);
    expect(f.grapeInserts()[0]?.params[1]).toBe(GRAPE_KEK);
  });

  it('a nevbol eltunt dulot NULLRA allitja', async () => {
    // A nevbol szarmazo slotoknal a parser a hatosag: ha a friss szotar
    // szerint az a token mar nem dulo, akkor a regi ertek TEVES.
    const f = fakeClient();
    const result = await applyWineIdentity(
      f.client,
      row({ producer_id: 'prod-sauska', vineyard_id: 'vin-regi' }),
      parse({ producer: match('producer', 'prod-sauska', 'Sauska') }),
      lookups,
    );
    expect(result.fields).toContain('vineyard_id');
    expect(f.updates()[0]?.params[3]).toBeNull();
  });
});

describe('forraserosseg', () => {
  it('a nevbol olvasott evjarat NEM irja felul a meglevot', async () => {
    // A spec-tablabol vagy JSON-LD-bol kinyert evjarat erosebb bizonyitek.
    const f = fakeClient();
    const result = await applyWineIdentity(
      f.client,
      row({ producer_id: null, vintage_value: 2020 }),
      parse({ producer: match('producer', 'prod-sauska', 'Sauska'), vintageValue: 2019 }),
      lookups,
    );
    expect(result.fields).not.toContain('vintage_value');
    expect(f.updates()[0]?.params[8]).toBe(2020);
  });

  it('a hianyzo evjaratot viszont kitolti', async () => {
    const f = fakeClient();
    const result = await applyWineIdentity(
      f.client,
      row({ vintage_value: null }),
      parse({ producer: match('producer', 'prod-sauska', 'Sauska'), vintageValue: 2019 }),
      lookups,
    );
    expect(result.fields).toContain('vintage_value');
    expect(f.updates()[0]?.params[8]).toBe(2019);
  });

  it('a meglevo szint nem irja felul', async () => {
    const f = fakeClient();
    const result = await applyWineIdentity(
      f.client,
      row({ colour: 'vörös' }),
      parse({
        producer: match('producer', 'prod-sauska', 'Sauska'),
        style: match('style', STYLE_RED, 'vörös'),
      }),
      lookups,
    );
    expect(result.fields).not.toContain('colour');
    expect(f.updates()[0]?.params[9]).toBe('vörös');
  });
});

describe('a szin levezetese', () => {
  it('a bortipus mondja ki', async () => {
    const f = fakeClient();
    await applyWineIdentity(
      f.client, row(),
      parse({
        producer: match('producer', 'p', 'P'),
        style: match('style', STYLE_ROSE, 'rosé'),
        grapes: [match('grape', GRAPE_KEK, 'Kékfrankos')],
      }),
      lookups,
    );
    // A tipus eros, a fajta alapertelmezese ("red") nem nyerhet felette.
    expect(f.updates()[0]?.params[9]).toBe('rose');
  });

  it('egyertelmu fajtaszin eseten a fajtabol jon', async () => {
    const f = fakeClient();
    await applyWineIdentity(
      f.client, row(),
      parse({
        producer: match('producer', 'p', 'P'),
        grapes: [match('grape', GRAPE_KEK, 'Kékfrankos')],
      }),
      lookups,
    );
    expect(f.updates()[0]?.params[9]).toBe('red');
  });

  it('vegyes szinu cuvee-nel NEM allit szint', async () => {
    // A "kek + feher" nem rose. A nem tudjuk jobb, mint a rossz valasz.
    const f = fakeClient();
    await applyWineIdentity(
      f.client, row(),
      parse({
        producer: match('producer', 'p', 'P'),
        grapes: [match('grape', GRAPE_KEK, 'Kékfrankos'), match('grape', GRAPE_OLASZ, 'Olaszrizling')],
      }),
      lookups,
    );
    expect(f.updates()[0]?.params[9]).toBeNull();
  });

  it('ismeretlen szinu fajta eseten sem tippel', async () => {
    const f = fakeClient();
    await applyWineIdentity(
      f.client, row(),
      parse({
        producer: match('producer', 'p', 'P'),
        grapes: [match('grape', GRAPE_KEK, 'Kékfrankos'), match('grape', 'grape-nocolour', 'Ismeretlen')],
      }),
      lookups,
    );
    expect(f.updates()[0]?.params[9]).toBeNull();
  });
});

describe('a fajtalenyomat', () => {
  it('halmaz, nem lista: a sorrend nem befolyasolja', async () => {
    const a = fakeClient();
    await applyWineIdentity(
      a.client, row(),
      parse({
        producer: match('producer', 'p', 'P'),
        grapes: [match('grape', GRAPE_KEK, 'K'), match('grape', GRAPE_OLASZ, 'O')],
      }),
      lookups,
    );
    const b = fakeClient();
    await applyWineIdentity(
      b.client, row(),
      parse({
        producer: match('producer', 'p', 'P'),
        grapes: [match('grape', GRAPE_OLASZ, 'O'), match('grape', GRAPE_KEK, 'K')],
      }),
      lookups,
    );
    expect(a.updates()[0]?.params[5]).toBe(b.updates()[0]?.params[5]);
  });

  it('fajta nelkul NULL, nem ures sztring', async () => {
    // A "nem tudjuk" es a "bizonyitottan fajta nelkuli" nem mosodhat ossze.
    const f = fakeClient();
    await applyWineIdentity(
      f.client, row(), parse({ producer: match('producer', 'p', 'P') }), lookups,
    );
    expect(f.updates()[0]?.params[5]).toBeNull();
  });
});

describe('az identitas-lenyomat megkulonbozteti a borokat', () => {
  it('azonos termelo + evjarat, MAS fajta -> mas hash', async () => {
    // A v2 lenyomat nem ismerte a fajtat, ezert a "Sauska Kekfrankos 2019" es
    // a "Sauska Olaszrizling 2019" azonos hasht kapott. Ket kulonbozo bor,
    // egy ujjlenyomat - a jovahagyas auditnyoma igy nem mondta meg, MIT
    // hagyott jova az ember.
    const a = fakeClient();
    await applyWineIdentity(
      a.client, row({ raw_name: 'Sauska Kékfrankos 2019' }),
      parse({
        producer: match('producer', 'p', 'Sauska'),
        grapes: [match('grape', GRAPE_KEK, 'Kékfrankos')],
        vintageValue: 2019,
      }), lookups);

    const b = fakeClient();
    await applyWineIdentity(
      b.client, row({ raw_name: 'Sauska Olaszrizling 2019' }),
      parse({
        producer: match('producer', 'p', 'Sauska'),
        grapes: [match('grape', GRAPE_OLASZ, 'Olaszrizling')],
        vintageValue: 2019,
      }), lookups);

    expect(a.updates()[0]?.params[10]).not.toBe(b.updates()[0]?.params[10]);
  });

  it('ugyanaz a bor ket boltbol, MAS SORRENDU nevvel -> azonos hash', async () => {
    // A platformazonositok boltspecifikusak, ezert itt nincsenek - ami marad,
    // az a tenyleges azonossag.
    const a = fakeClient();
    await applyWineIdentity(
      a.client, row({ raw_name: 'Sauska Kékfrankos 2019', platform_product_id: null }),
      parse({
        producer: match('producer', 'p', 'Sauska'),
        grapes: [match('grape', GRAPE_KEK, 'Kékfrankos')],
        vintageValue: 2019,
      }), lookups);

    const b = fakeClient();
    await applyWineIdentity(
      b.client, row({ raw_name: '2019 Sauska Kékfrankos 0,75 l', platform_product_id: null }),
      parse({
        producer: match('producer', 'p', 'Sauska'),
        grapes: [match('grape', GRAPE_KEK, 'Kékfrankos')],
        vintageValue: 2019,
      }), lookups);

    expect(a.updates()[0]?.params[10]).toBe(b.updates()[0]?.params[10]);
  });
});

describe('a besorolas', () => {
  it('a besorolatlan sor BOR lesz, ha a nev a szotarbol oldodott fel', async () => {
    // A kategoria hozza magaval az identitasprofilt: az `uncategorized`
    // szerint a fantazianev KOTELEZO, a bor szerint viszont hianyozhat a
    // bolti nevbol. Kategoria nelkul minden borpar "kotelezo tetel nem
    // bizonyitott" indokkal allna meg az ellenorzesben.
    const f = fakeClient();
    const result = await applyWineIdentity(
      f.client, row({ category_id: null }),
      parse({
        producer: match('producer', 'p', 'Sauska'),
        grapes: [match('grape', GRAPE_KEK, 'Kékfrankos')],
      }), lookups);
    expect(result.fields).toContain('category_id');
    expect(f.updates()[0]?.params[11]).toBe(WINE_CATEGORY);
  });

  it('boraszat ONMAGABAN nem bizonyitja, hogy bor', async () => {
    // Egy pinceszet poharat es ajandekkartyat is arul.
    const f = fakeClient();
    const result = await applyWineIdentity(
      f.client, row({ category_id: null, expression: 'valami' }),
      parse({ producer: match('producer', 'p', 'Sauska'), expression: 'dekanter' }),
      lookups);
    expect(result.fields).not.toContain('category_id');
    expect(f.updates()[0]?.params[11]).toBeNull();
  });

  it('a meglevo besorolast nem irja felul', async () => {
    const f = fakeClient();
    const result = await applyWineIdentity(
      f.client, row({ category_id: 'cat-sparkling' }),
      parse({
        producer: match('producer', 'p', 'Sauska'),
        grapes: [match('grape', GRAPE_KEK, 'Kékfrankos')],
      }), lookups);
    expect(result.fields).not.toContain('category_id');
    expect(f.updates()[0]?.params[11]).toBe('cat-sparkling');
  });
});

describe('az evjarat allapota', () => {
  it('a nevbol talalt evszam evjaratos borra allitja az allapotot', async () => {
    // A parosito nem a szamot nezi, hanem az ALLAPOTOT: amig `unknown`, addig
    // a 2019 nem szamit bizonyitottnak. A bor profilja szerint az evjarat
    // kotelezo, tehat allapot nelkul minden borpar megallna az
    // ellenorzesben - "kotelezo evjarat nem bizonyitott" indokkal.
    const f = fakeClient();
    const result = await applyWineIdentity(
      f.client, row({ vintage_value: null, vintage_status: 'unknown' }),
      parse({ producer: match('producer', 'p', 'Sauska'), vintageValue: 2019 }),
      lookups);
    expect(result.fields).toContain('vintage_status');
    expect(f.updates()[0]?.params[12]).toBe('vintage');
  });

  it('a mar kimondott allapotot nem irja felul', async () => {
    // Egy evjarat nelkuli pezsgonel a nevben szereplo evszam mas jelentesu
    // (pl. alapitasi ev) - a kimondott `non_vintage` erosebb.
    const f = fakeClient();
    const result = await applyWineIdentity(
      f.client, row({ vintage_status: 'non_vintage' }),
      parse({ producer: match('producer', 'p', 'Sauska'), vintageValue: 2019 }),
      lookups);
    expect(result.fields).not.toContain('vintage_status');
    expect(f.updates()[0]?.params[12]).toBe('non_vintage');
  });

  it('evszam nelkul nem allit evjaratot', async () => {
    const f = fakeClient();
    await applyWineIdentity(
      f.client, row({ vintage_value: null, vintage_status: 'unknown' }),
      parse({
        producer: match('producer', 'p', 'Sauska'),
        grapes: [match('grape', GRAPE_KEK, 'Kékfrankos')],
      }), lookups);
    expect(f.updates()[0]?.params[12]).toBe('unknown');
  });
});
