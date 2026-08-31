-- ============================================================================
-- 0011  Bor referenciaadat: bortípusok és szőlőfajták, szinonimákkal
--
-- Ez ZÁRT referenciaadat, nem a korpuszból bányászott jelöltek. Néhány száz
-- fajtáról van szó, amelyek listája ismert — a korpuszból kinyerni
-- kockázatosabb és rosszabb minőségű lenne.
--
-- A szinonimák az aliases táblába kerülnek, `approved = true` értékkel:
-- ezek nem javaslatok, hanem tényként kezelt névváltozatok.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Bortípusok
-- ---------------------------------------------------------------------------
INSERT INTO wine_styles (key, canonical_name, colour, puttony_relevant, sparkling, sort_order) VALUES
  ('red',           'vörös',              'red',    false, false, 10),
  ('white',         'fehér',              'white',  false, false, 20),
  ('rose',          'rosé',               'rose',   false, false, 30),
  ('siller',        'siller',             'rose',   false, false, 35),
  ('orange',        'narancsbor',         'orange', false, false, 40),
  ('sparkling',     'pezsgő',             NULL,     false, true,  50),
  ('semi_sparkling','gyöngyöző',          NULL,     false, true,  55),
  ('aszu',          'aszú',               'white',  true,  false, 60),
  ('szamorodni',    'szamorodni',         'white',  false, false, 65),
  ('forditas',      'fordítás',           'white',  false, false, 70),
  ('maslas',        'máslás',             'white',  false, false, 75),
  ('esszencia',     'esszencia',          'white',  false, false, 80),
  ('late_harvest',  'késői szüretelésű',  NULL,     false, false, 85),
  ('ice_wine',      'jégbor',             'white',  false, false, 90)
ON CONFLICT (key) DO UPDATE
  SET canonical_name = EXCLUDED.canonical_name, colour = EXCLUDED.colour,
      puttony_relevant = EXCLUDED.puttony_relevant, sparkling = EXCLUDED.sparkling;

-- Bortípus-szinonimák
INSERT INTO aliases (alias_type, alias_text, target_kind, target_id, source, approved, approved_at)
SELECT 'wine_style', a.alias, 'wine_style', s.id, 'import', true, now()
FROM (VALUES
  ('red','vörösbor'), ('red','voros'), ('red','vörös bor'), ('red','red'), ('red','rouge'), ('red','tinto'),
  ('white','fehérbor'), ('white','fehér bor'), ('white','white'), ('white','blanc'), ('white','bianco'),
  ('rose','rozé'), ('rose','roze'), ('rose','rose'), ('rose','rosébor'), ('rose','rozébor'),
  ('orange','orange wine'), ('orange','narancs bor'), ('orange','amber'),
  ('sparkling','pezsgo'), ('sparkling','habzóbor'), ('sparkling','sparkling'), ('sparkling','spumante'),
  ('semi_sparkling','frizzante'), ('semi_sparkling','perlwein'),
  ('aszu','tokaji aszú'), ('aszu','aszu'), ('aszu','aszú bor'),
  ('szamorodni','édes szamorodni'), ('szamorodni','száraz szamorodni'),
  ('late_harvest','késői szüret'), ('late_harvest','late harvest'), ('late_harvest','spatlese'),
  ('ice_wine','eiswein'), ('ice_wine','ice wine')
) AS a(skey, alias)
JOIN wine_styles s ON s.key = a.skey
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------------
-- Szőlőfajták. A `fuzzy_blocked` alapból true (lásd 0010) — az elfogadott
-- névváltozatok aliasként, auditáltan kerülnek be.
-- ---------------------------------------------------------------------------
INSERT INTO grape_varieties (canonical_name, colour_default, country_origin, is_blend) VALUES
  -- ── Magyar fehér ──────────────────────────────────────────────────────
  ('Furmint','white','HU',false),
  ('Hárslevelű','white','HU',false),
  ('Olaszrizling','white','HU',false),
  ('Juhfark','white','HU',false),
  ('Kéknyelű','white','HU',false),
  ('Ezerjó','white','HU',false),
  ('Leányka','white','HU',false),
  ('Királyleányka','white','HU',false),
  ('Cserszegi fűszeres','white','HU',false),
  ('Irsai Olivér','white','HU',false),
  ('Zenit','white','HU',false),
  ('Zefír','white','HU',false),
  ('Generosa','white','HU',false),
  ('Sárgamuskotály','white','HU',false),
  ('Szürkebarát','white','HU',false),
  ('Tramini','white','HU',false),
  ('Rajnai rizling','white','DE',false),
  ('Rizlingszilváni','white','CH',false),
  ('Zöld veltelini','white','AT',false),
  ('Kövérszőlő','white','HU',false),
  ('Zéta','white','HU',false),
  ('Kabar','white','HU',false),
  ('Budai zöld','white','HU',false),
  ('Bianca','white','HU',false),
  ('Csabagyöngye','white','HU',false),
  ('Mézes fehér','white','HU',false),
  -- ── Magyar vörös ──────────────────────────────────────────────────────
  ('Kékfrankos','red','HU',false),
  ('Kadarka','red','HU',false),
  ('Kékoportó','red','PT',false),
  ('Kékburgundi','red','FR',false),
  ('Turán','red','HU',false),
  ('Bíborkadarka','red','HU',false),
  ('Csókaszőlő','red','HU',false),
  ('Menoire','red','HU',false),
  ('Kékmedoc','red','FR',false),
  ('Zweigelt','red','AT',false),
  -- ── Nemzetközi vörös ──────────────────────────────────────────────────
  ('Cabernet Sauvignon','red','FR',false),
  ('Cabernet Franc','red','FR',false),
  ('Merlot','red','FR',false),
  ('Syrah','red','FR',false),
  ('Malbec','red','FR',false),
  ('Petit Verdot','red','FR',false),
  ('Tempranillo','red','ES',false),
  ('Garnacha','red','ES',false),
  ('Monastrell','red','ES',false),
  ('Sangiovese','red','IT',false),
  ('Nebbiolo','red','IT',false),
  ('Barbera','red','IT',false),
  ('Montepulciano','red','IT',false),
  ('Nero d''Avola','red','IT',false),
  ('Corvina','red','IT',false),
  ('Aglianico','red','IT',false),
  ('Primitivo','red','IT',false),
  ('Carmenère','red','FR',false),
  ('Touriga Nacional','red','PT',false),
  ('Gamay','red','FR',false),
  ('Dolcetto','red','IT',false),
  ('Tannat','red','FR',false),
  ('Pinotage','red','ZA',false),
  ('Petite Sirah','red','FR',false),
  -- ── Nemzetközi fehér ──────────────────────────────────────────────────
  ('Chardonnay','white','FR',false),
  ('Sauvignon Blanc','white','FR',false),
  ('Pinot Blanc','white','FR',false),
  ('Chenin Blanc','white','FR',false),
  ('Sémillon','white','FR',false),
  ('Viognier','white','FR',false),
  ('Marsanne','white','FR',false),
  ('Roussanne','white','FR',false),
  ('Colombard','white','FR',false),
  ('Albariño','white','ES',false),
  ('Verdejo','white','ES',false),
  ('Vermentino','white','IT',false),
  ('Trebbiano','white','IT',false),
  ('Garganega','white','IT',false),
  ('Glera','white','IT',false),
  ('Torrontés','white','AR',false),
  ('Assyrtiko','white','GR',false),
  ('Silvaner','white','DE',false),
  ('Kerner','white','DE',false),
  ('Scheurebe','white','DE',false),
  ('Muscat Ottonel','white','FR',false),
  -- ── Házasítás ─────────────────────────────────────────────────────────
  ('Cuvée',NULL,NULL,true)
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------------
-- Fajta-szinonimák.
--
-- A többszavas változatok (pl. 'olasz rizling') NEM elhagyhatók: a parser
-- leghosszabb-egyezés-először dolgozik, és e nélkül a 'rizling' részlet a
-- Rajnai rizlingre illeszkedne egy Olaszrizling nevében.
-- ---------------------------------------------------------------------------
INSERT INTO aliases (alias_type, alias_text, target_kind, target_id, source, approved, approved_at)
SELECT 'grape', a.alias, 'grape_variety', g.id, 'import', true, now()
FROM (VALUES
  -- magyar fehér
  ('Olaszrizling','Welschriesling'), ('Olaszrizling','Riesling Italico'),
  ('Olaszrizling','Grasevina'), ('Olaszrizling','Graševina'),
  ('Olaszrizling','Laski Rizling'), ('Olaszrizling','olasz rizling'),
  ('Furmint','Šipon'), ('Furmint','Sipon'), ('Furmint','Mosler'),
  ('Hárslevelű','Lipovina'), ('Hárslevelű','hars leveluu'), ('Hárslevelű','hárs levelű'),
  ('Szürkebarát','Pinot Gris'), ('Szürkebarát','Pinot Grigio'),
  ('Szürkebarát','Grauburgunder'), ('Szürkebarát','Ruländer'), ('Szürkebarát','szürke barát'),
  ('Tramini','Gewürztraminer'), ('Tramini','Gewurztraminer'), ('Tramini','Traminer'),
  ('Rajnai rizling','Riesling'), ('Rajnai rizling','Rheinriesling'),
  ('Rajnai rizling','Weisser Riesling'), ('Rajnai rizling','rajnai'),
  ('Rizlingszilváni','Müller-Thurgau'), ('Rizlingszilváni','Muller Thurgau'),
  ('Rizlingszilváni','rizling szilváni'),
  ('Zöld veltelini','Grüner Veltliner'), ('Zöld veltelini','Gruner Veltliner'),
  ('Zöld veltelini','Veltliner'), ('Zöld veltelini','zöldveltelini'),
  ('Sárgamuskotály','Muscat Lunel'), ('Sárgamuskotály','sárga muskotály'),
  ('Sárgamuskotály','Muskotály'), ('Sárgamuskotály','Muscat Blanc'),
  ('Királyleányka','Fetească Regală'), ('Királyleányka','Feteasca Regala'),
  ('Királyleányka','király leányka'),
  ('Cserszegi fűszeres','cserszegi'),
  ('Irsai Olivér','irsai'),
  -- magyar vörös
  ('Kékfrankos','Blaufränkisch'), ('Kékfrankos','Blaufrankisch'),
  ('Kékfrankos','Lemberger'), ('Kékfrankos','Frankovka'), ('Kékfrankos','kék frankos'),
  ('Kadarka','Gamza'), ('Kadarka','Szkadarka'),
  ('Kékoportó','Portugieser'), ('Kékoportó','Blauer Portugieser'),
  ('Kékoportó','Oportó'), ('Kékoportó','kék oportó'),
  ('Kékburgundi','Pinot Noir'), ('Kékburgundi','Spätburgunder'),
  ('Kékburgundi','Blauburgunder'), ('Kékburgundi','kék burgundi'), ('Kékburgundi','Pinot Nero'),
  -- nemzetközi vörös
  ('Syrah','Shiraz'),
  ('Garnacha','Grenache'), ('Garnacha','Cannonau'), ('Garnacha','Grenache Noir'),
  ('Monastrell','Mourvèdre'), ('Monastrell','Mourvedre'), ('Monastrell','Mataro'),
  ('Primitivo','Zinfandel'),
  ('Cabernet Sauvignon','cabernet sauvignon'), ('Cabernet Sauvignon','CS'),
  ('Cabernet Franc','cabernet franc'), ('Cabernet Franc','CF'),
  ('Carmenère','Carmenere'),
  ('Nero d''Avola','Nero d Avola'), ('Nero d''Avola','Calabrese'),
  -- nemzetközi fehér
  ('Pinot Blanc','Weissburgunder'), ('Pinot Blanc','Pinot Bianco'), ('Pinot Blanc','Weißburgunder'),
  ('Sémillon','Semillon'),
  ('Chardonnay','Morillon'),
  ('Trebbiano','Ugni Blanc'),
  ('Albariño','Albarino'), ('Albariño','Alvarinho'),
  ('Torrontés','Torrontes'),
  ('Glera','Prosecco'),
  -- házasítás
  ('Cuvée','Cuvee'), ('Cuvée','Küvé'), ('Cuvée','Házasítás'),
  ('Cuvée','Blend'), ('Cuvée','Kuvé')
) AS a(canon, alias)
JOIN grape_varieties g ON g.name_norm = rv_search_norm(a.canon)
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------------
-- Negatív aliasok: fajták, amelyek közös szót tartalmaznak, de KÜLÖN fajták.
-- Ezek a leggyakoribb hamis egyezések forrásai egy tokenalapú illesztésben.
-- ---------------------------------------------------------------------------
INSERT INTO negative_aliases (left_text, right_text, category_id, reason)
SELECT n.l, n.r, (SELECT id FROM product_categories WHERE key = 'wine'), n.reason
FROM (VALUES
  ('Cabernet Sauvignon','Sauvignon Blanc','Közös "Sauvignon" szó, de két különböző fajta — az egyik vörös, a másik fehér.'),
  ('Cabernet Sauvignon','Cabernet Franc','Két külön Cabernet-fajta.'),
  ('Pinot Noir','Pinot Blanc','Külön fajta, eltérő szín.'),
  ('Pinot Noir','Pinot Gris','Külön fajta, eltérő szín.'),
  ('Pinot Blanc','Pinot Gris','Külön fajta.'),
  ('Olaszrizling','Rajnai rizling','Két külön fajta; a közös "rizling" szó megtévesztő.'),
  ('Olaszrizling','Rizlingszilváni','Két külön fajta.'),
  ('Rajnai rizling','Rizlingszilváni','Két külön fajta.'),
  ('Kékfrankos','Kékoportó','Külön fajta.'),
  ('Kékfrankos','Kékburgundi','Külön fajta.'),
  ('Kadarka','Bíborkadarka','A bíborkadarka önálló fajta, nem a kadarka névváltozata.'),
  ('Furmint','Hárslevelű','Külön fajta; a tokaji dűlőkben gyakran együtt szerepelnek.'),
  ('Syrah','Petite Sirah','A Petite Sirah nem a Syrah kicsinyítése, hanem külön fajta.'),
  ('Muscat Ottonel','Sárgamuskotály','Két külön muskotályfajta.'),
  ('Tramini','Rajnai rizling','Külön fajta.'),
  ('aszú','szamorodni','Két külön tokaji bortípus.'),
  ('aszú','fordítás','Két külön tokaji bortípus.'),
  ('szamorodni','fordítás','Két külön tokaji bortípus.'),
  ('vörös','rosé','Külön bortípus.'),
  ('fehér','rosé','Külön bortípus.'),
  ('vörös','fehér','Külön bortípus.')
) AS n(l, r, reason)
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------------
-- Borvidékek. A magyar nevekben szinte mindig MELLÉKNÉVI alakban jelennek meg
-- ("Villányi Kékfrankos", "Tokaji Furmint"), ezért az alias itt nem luxus,
-- hanem a felismerés feltétele.
-- ---------------------------------------------------------------------------
INSERT INTO wine_regions (canonical_name, country_code) VALUES
  ('Tokaj','HU'), ('Eger','HU'), ('Mátra','HU'), ('Bükk','HU'),
  ('Kunság','HU'), ('Csongrád','HU'), ('Hajós-Baja','HU'), ('Szekszárd','HU'),
  ('Villány','HU'), ('Pécs','HU'), ('Tolna','HU'), ('Balatonboglár','HU'),
  ('Balatonfüred-Csopak','HU'), ('Badacsony','HU'), ('Balaton-felvidék','HU'),
  ('Nagy-Somló','HU'), ('Zala','HU'), ('Pannonhalma','HU'), ('Mór','HU'),
  ('Etyek-Buda','HU'), ('Neszmély','HU'), ('Sopron','HU'), ('Balaton','HU'),
  ('Bordeaux','FR'), ('Bourgogne','FR'), ('Champagne','FR'), ('Rhône','FR'),
  ('Rioja','ES'), ('Ribera del Duero','ES'), ('Priorat','ES'),
  ('Toscana','IT'), ('Piemonte','IT'), ('Veneto','IT'), ('Sicilia','IT'),
  ('Douro','PT'), ('Mosel','DE'), ('Rheingau','DE'), ('Wachau','AT'),
  ('Barossa Valley','AU'), ('Marlborough','NZ'), ('Mendoza','AR'), ('Napa Valley','US')
ON CONFLICT DO NOTHING;

INSERT INTO aliases (alias_type, alias_text, target_kind, target_id, source, approved, approved_at)
SELECT 'wine_region', a.alias, 'wine_region', r.id, 'import', true, now()
FROM (VALUES
  ('Tokaj','Tokaji'), ('Tokaj','Tokaj-Hegyalja'), ('Tokaj','Tokajhegyalja'),
  ('Eger','Egri'), ('Mátra','Mátrai'), ('Bükk','Bükki'),
  ('Kunság','Kunsági'), ('Csongrád','Csongrádi'), ('Hajós-Baja','Hajós-Bajai'),
  ('Szekszárd','Szekszárdi'), ('Villány','Villányi'), ('Villány','Villány-Siklós'),
  ('Pécs','Pécsi'), ('Tolna','Tolnai'), ('Balatonboglár','Balatonboglári'),
  ('Balatonfüred-Csopak','Csopaki'), ('Badacsony','Badacsonyi'),
  ('Balaton-felvidék','Balaton-felvidéki'), ('Nagy-Somló','Somlói'), ('Nagy-Somló','Somló'),
  ('Zala','Zalai'), ('Pannonhalma','Pannonhalmi'), ('Mór','Móri'),
  ('Etyek-Buda','Etyeki'), ('Neszmély','Neszmélyi'), ('Sopron','Soproni'),
  ('Balaton','Balatoni'),
  ('Bourgogne','Burgundy'), ('Bourgogne','Burgundia'),
  ('Toscana','Tuscany'), ('Toscana','Toszkána'),
  ('Rhône','Rhone'), ('Sicilia','Sicily'), ('Sicilia','Szicília')
) AS a(canon, alias)
JOIN wine_regions r ON r.name_norm = rv_search_norm(a.canon)
ON CONFLICT DO NOTHING;
