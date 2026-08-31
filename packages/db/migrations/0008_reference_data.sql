-- ============================================================================
-- 0008  Referenciaadatok: kategóriák + identitásprofilok, crawl policyk,
--       az első kör 10+1 webshopja, identitáshordozó kifejezések,
--       negatív aliasok, alapbeállítások, feature flagek.
-- Spec 2.1, 10., 13.2, 15.5, 28., 32.2
-- Minden INSERT idempotens (ON CONFLICT DO NOTHING / DO UPDATE).
-- ============================================================================

-- ─── Kategóriák és kategóriafüggő identitásprofil (spec 10.) ────────────────
INSERT INTO product_categories (key, name_hu, name_en, kind, sort_order, identity_profile, comparison_policy, noise_terms) VALUES
('wine', 'Bor', 'Wine', 'wine', 10,
 '{"required":["producer","expression","vintage","volume_ml","pack_count","packaging_type"],
   "contradiction_only":["colour","region","sweetness","abv_percent","edition","gtin","grape_varieties","appellation"],
   "supporting":["country_code","vineyard","organic"],
   "not_applicable":["age_statement_years","dosage_style","cask_finish","puttony"],
   "vintageSensitive":true,
   "gtinResolvesVintage":false,
   "notes":"Bornál az EAN több évjáraton át változatlan lehet, ezért nem oldja fel az évjáratot (spec 10.2)."}'::jsonb,
 '{"giftBoxEquivalent":false,"volumeToleranceMl":5,"packMustMatch":true,
   "allowedPriceTypes":["regular","sale"],"freshnessMaxHours":240,"requireInStock":false}'::jsonb,
 ARRAY['akcio','akcios','rendeld meg','ingyenes szallitas','uj','kedvenc','ajanlott']),

('sparkling_wine', 'Pezsgő', 'Sparkling wine', 'wine', 20,
 '{"required":["producer","expression","dosage_style","vintage_status","volume_ml","pack_count","packaging_type"],
   "contradiction_only":["vintage","colour","region","abv_percent","edition","gtin"],
   "supporting":["country_code","grape_varieties"],
   "not_applicable":["age_statement_years","cask_finish","puttony"],
   "vintageSensitive":true,
   "gtinResolvesVintage":false,
   "notes":"Vintage és NV pezsgő nem azonos (spec 3.1)."}'::jsonb,
 '{"giftBoxEquivalent":false,"volumeToleranceMl":5,"packMustMatch":true,
   "allowedPriceTypes":["regular","sale"],"freshnessMaxHours":240,"requireInStock":false}'::jsonb,
 ARRAY['akcio','akcios','rendeld meg']),

('champagne', 'Champagne', 'Champagne', 'wine', 21,
 '{"required":["producer","expression","dosage_style","vintage_status","volume_ml","pack_count","packaging_type"],
   "contradiction_only":["vintage","region","abv_percent","edition","gtin","colour"],
   "supporting":["country_code","grape_varieties"],
   "not_applicable":["age_statement_years","cask_finish","puttony"],
   "vintageSensitive":true,"gtinResolvesVintage":false}'::jsonb,
 '{"giftBoxEquivalent":false,"volumeToleranceMl":5,"packMustMatch":true,
   "allowedPriceTypes":["regular","sale"],"freshnessMaxHours":240,"requireInStock":false}'::jsonb,
 ARRAY['akcio','akcios']),

('tokaji_aszu', 'Tokaji aszú', 'Tokaji Aszu', 'wine', 30,
 '{"required":["producer","expression","vintage","puttony","volume_ml","pack_count","packaging_type"],
   "contradiction_only":["region","sweetness","abv_percent","edition","gtin"],
   "supporting":["country_code","vineyard"],
   "not_applicable":["age_statement_years","dosage_style","cask_finish"],
   "vintageSensitive":true,"gtinResolvesVintage":false,
   "notes":"5 és 6 puttonyos aszú nem azonos termék (spec 3.1)."}'::jsonb,
 '{"giftBoxEquivalent":false,"volumeToleranceMl":5,"packMustMatch":true,
   "allowedPriceTypes":["regular","sale"],"freshnessMaxHours":240,"requireInStock":false}'::jsonb,
 ARRAY['akcio']),

('whisky', 'Whisky', 'Whisky', 'spirit', 40,
 '{"required":["brand","expression","volume_ml","pack_count","packaging_type"],
   "contradiction_only":["age_statement_years","edition","cask_finish","abv_percent","batch_code","gtin","country_code","vintage"],
   "supporting":["region","subcategory"],
   "not_applicable":["dosage_style","puttony","grape_varieties"],
   "vintageSensitive":false,"gtinResolvesVintage":true,
   "notes":"Black Label és Double Black külön expression (spec 3.1)."}'::jsonb,
 '{"giftBoxEquivalent":false,"volumeToleranceMl":5,"packMustMatch":true,
   "allowedPriceTypes":["regular","sale"],"freshnessMaxHours":240,"requireInStock":false}'::jsonb,
 ARRAY['akcio','akcios','rendeld meg','dobozos ajanlat']),

('rum', 'Rum', 'Rum', 'spirit', 41,
 '{"required":["brand","expression","volume_ml","pack_count","packaging_type"],
   "contradiction_only":["age_statement_years","edition","cask_finish","abv_percent","gtin","country_code"],
   "supporting":["region","subcategory"],
   "not_applicable":["dosage_style","puttony","grape_varieties","vintage"],
   "vintageSensitive":false,"gtinResolvesVintage":true}'::jsonb,
 '{"giftBoxEquivalent":false,"volumeToleranceMl":5,"packMustMatch":true,
   "allowedPriceTypes":["regular","sale"],"freshnessMaxHours":240,"requireInStock":false}'::jsonb,
 ARRAY['akcio']),

('gin', 'Gin', 'Gin', 'spirit', 42,
 '{"required":["brand","expression","volume_ml","pack_count","packaging_type"],
   "contradiction_only":["edition","abv_percent","gtin","flavour","country_code"],
   "supporting":["subcategory","region"],
   "not_applicable":["dosage_style","puttony","grape_varieties","vintage","age_statement_years"],
   "vintageSensitive":false,"gtinResolvesVintage":true,
   "notes":"A Sloe Gin nem azonos a London Dry Ginnel (spec 10.4)."}'::jsonb,
 '{"giftBoxEquivalent":false,"volumeToleranceMl":5,"packMustMatch":true,
   "allowedPriceTypes":["regular","sale"],"freshnessMaxHours":240,"requireInStock":false}'::jsonb,
 ARRAY['akcio']),

('vodka', 'Vodka', 'Vodka', 'spirit', 43,
 '{"required":["brand","expression","volume_ml","pack_count","packaging_type"],
   "contradiction_only":["edition","abv_percent","gtin","flavour","country_code"],
   "supporting":["subcategory"],
   "not_applicable":["dosage_style","puttony","grape_varieties","vintage","age_statement_years"],
   "vintageSensitive":false,"gtinResolvesVintage":true}'::jsonb,
 '{"giftBoxEquivalent":false,"volumeToleranceMl":5,"packMustMatch":true,
   "allowedPriceTypes":["regular","sale"],"freshnessMaxHours":240,"requireInStock":false}'::jsonb,
 ARRAY['akcio']),

('cognac', 'Konyak / Brandy', 'Cognac / Brandy', 'spirit', 44,
 '{"required":["brand","expression","volume_ml","pack_count","packaging_type"],
   "contradiction_only":["age_statement_years","edition","abv_percent","gtin","country_code"],
   "supporting":["region","subcategory"],
   "not_applicable":["dosage_style","puttony","grape_varieties","vintage"],
   "vintageSensitive":false,"gtinResolvesVintage":true,
   "notes":"VS / VSOP / XO külön expression (spec 10.4)."}'::jsonb,
 '{"giftBoxEquivalent":false,"volumeToleranceMl":5,"packMustMatch":true,
   "allowedPriceTypes":["regular","sale"],"freshnessMaxHours":240,"requireInStock":false}'::jsonb,
 ARRAY['akcio']),

('tequila', 'Tequila / Mezcal', 'Tequila / Mezcal', 'spirit', 45,
 '{"required":["brand","expression","volume_ml","pack_count","packaging_type"],
   "contradiction_only":["edition","abv_percent","gtin","country_code","age_statement_years"],
   "supporting":["subcategory"],
   "not_applicable":["dosage_style","puttony","grape_varieties","vintage"],
   "vintageSensitive":false,"gtinResolvesVintage":true}'::jsonb,
 '{"giftBoxEquivalent":false,"volumeToleranceMl":5,"packMustMatch":true,
   "allowedPriceTypes":["regular","sale"],"freshnessMaxHours":240,"requireInStock":false}'::jsonb,
 ARRAY['akcio']),

('liqueur', 'Likőr', 'Liqueur', 'spirit', 46,
 '{"required":["brand","expression","volume_ml","pack_count","packaging_type"],
   "contradiction_only":["edition","abv_percent","gtin","flavour"],
   "supporting":["subcategory","country_code"],
   "not_applicable":["dosage_style","puttony","grape_varieties","vintage","age_statement_years"],
   "vintageSensitive":false,"gtinResolvesVintage":true}'::jsonb,
 '{"giftBoxEquivalent":false,"volumeToleranceMl":5,"packMustMatch":true,
   "allowedPriceTypes":["regular","sale"],"freshnessMaxHours":240,"requireInStock":false}'::jsonb,
 ARRAY['akcio']),

('palinka', 'Pálinka', 'Palinka', 'spirit', 50,
 '{"required":["producer","expression","volume_ml","pack_count","packaging_type"],
   "contradiction_only":["fruit","edition","abv_percent","gtin","aging","vintage"],
   "supporting":["region","appellation"],
   "not_applicable":["dosage_style","puttony","grape_varieties","age_statement_years"],
   "vintageSensitive":false,"gtinResolvesVintage":true,
   "notes":"A gyümölcsfajta kötelező identitáselem, az ágyas/érlelt jelölés kizáró (spec 10.5)."}'::jsonb,
 '{"giftBoxEquivalent":false,"volumeToleranceMl":5,"packMustMatch":true,
   "allowedPriceTypes":["regular","sale"],"freshnessMaxHours":240,"requireInStock":false}'::jsonb,
 ARRAY['akcio']),

('other_spirit', 'Egyéb szeszes ital', 'Other spirit', 'spirit', 60,
 '{"required":["brand","expression","volume_ml","pack_count","packaging_type"],
   "contradiction_only":["edition","abv_percent","gtin"],
   "supporting":["subcategory","country_code"],
   "not_applicable":["dosage_style","puttony","grape_varieties"],
   "vintageSensitive":false,"gtinResolvesVintage":true}'::jsonb,
 '{"giftBoxEquivalent":false,"volumeToleranceMl":5,"packMustMatch":true,
   "allowedPriceTypes":["regular","sale"],"freshnessMaxHours":240,"requireInStock":false}'::jsonb,
 ARRAY['akcio']),

('uncategorized', 'Besorolatlan', 'Uncategorized', 'other', 900,
 '{"required":["expression","volume_ml","pack_count"],
   "contradiction_only":["gtin","abv_percent","edition"],
   "supporting":[],
   "not_applicable":[],
   "vintageSensitive":true,"gtinResolvesVintage":false,
   "notes":"Besorolatlan termék soha nem kaphat auto-matchet."}'::jsonb,
 '{"giftBoxEquivalent":false,"volumeToleranceMl":5,"packMustMatch":true,
   "allowedPriceTypes":["regular"],"freshnessMaxHours":168,"requireInStock":false,"autoMatchBlocked":true}'::jsonb,
 ARRAY[]::text[])
ON CONFLICT (key) DO UPDATE
  SET identity_profile = EXCLUDED.identity_profile,
      comparison_policy = EXCLUDED.comparison_policy,
      noise_terms = EXCLUDED.noise_terms,
      name_hu = EXCLUDED.name_hu;

-- ─── Kategória-aliasok (webshopok kategórianeveihez) ────────────────────────
INSERT INTO category_aliases (category_id, alias)
SELECT c.id, a.alias FROM product_categories c
JOIN (VALUES
  ('wine','bor'), ('wine','borok'), ('wine','vörösbor'), ('wine','fehérbor'), ('wine','rosé'),
  ('wine','rozé'), ('wine','száraz bor'), ('wine','wine'), ('wine','magyar bor'), ('wine','külföldi bor'),
  ('sparkling_wine','pezsgő'), ('sparkling_wine','pezsgők'), ('sparkling_wine','habzóbor'),
  ('sparkling_wine','prosecco'), ('sparkling_wine','cava'), ('sparkling_wine','sparkling'),
  ('champagne','champagne'), ('champagne','pezsgő champagne'),
  ('tokaji_aszu','tokaji aszú'), ('tokaji_aszu','aszú'), ('tokaji_aszu','aszu'),
  ('whisky','whisky'), ('whisky','whiskey'), ('whisky','skót whisky'), ('whisky','bourbon'),
  ('whisky','single malt'), ('whisky','blended whisky'), ('whisky','ír whiskey'),
  ('rum','rum'), ('rum','rumok'),
  ('gin','gin'), ('gin','ginek'),
  ('vodka','vodka'), ('vodka','vodkák'),
  ('cognac','konyak'), ('cognac','cognac'), ('cognac','brandy'), ('cognac','armagnac'),
  ('tequila','tequila'), ('tequila','mezcal'),
  ('liqueur','likőr'), ('liqueur','likőrök'), ('liqueur','liqueur'), ('liqueur','keserű'),
  ('palinka','pálinka'), ('palinka','pálinkák'), ('palinka','palinka'),
  ('other_spirit','röviditalok'), ('other_spirit','tömény'), ('other_spirit','töményital'),
  ('other_spirit','szeszes ital'), ('other_spirit','spirits')
) AS a(cat, alias) ON a.cat = c.key
ON CONFLICT DO NOTHING;

-- ─── Crawl policyk ─────────────────────────────────────────────────────────
INSERT INTO crawl_policies (key, name, requests_per_second, max_concurrency, request_timeout_ms, max_retries, respect_robots, allow_browser, daily_request_budget) VALUES
('gentle',   'Kíméletes (alapértelmezett)', 0.5, 2, 20000, 3, true, false, 8000),
('standard', 'Normál',                      1.0, 3, 20000, 3, true, false, 20000),
('browser',  'Böngészős, alacsony terhelés',0.2, 1, 45000, 2, true, true,  1500),
('slow',     'Nagyon lassú / érzékeny forrás', 0.2, 1, 30000, 2, true, false, 3000)
ON CONFLICT (key) DO UPDATE SET name = EXCLUDED.name;

-- ─── Webshopok (spec 2.1). A RADOVIN egy a többi közül. ────────────────────
INSERT INTO shops (key, name, base_url, canonical_host, segment, adapter_key, discovery_strategy, crawl_policy_id, active, legal_review_status, brand_color, sort_order)
SELECT v.key, v.name, v.base_url, v.host, v.segment, v.adapter, v.strategy,
       (SELECT id FROM crawl_policies WHERE key = v.policy), false, 'pending', v.color, v.sort
FROM (VALUES
  ('radovin',      'RADOVIN',              'https://radovin.hu/',                'radovin.hu',            'mixed',  'generic-jsonld', 'sitemap',        'gentle', '#7B2233', 10),
  ('bortarsasag',  'Bortársaság',          'https://www.bortarsasag.hu/',        'www.bortarsasag.hu',    'wine',   'generic-jsonld', 'sitemap',        'gentle', '#8C1C2B', 20),
  ('veritas',      'Veritas Borkereskedés','https://www.borkereskedes.hu/',      'www.borkereskedes.hu',  'wine',   'generic-jsonld', 'sitemap',        'gentle', '#5C2233', 30),
  ('winelovers',   'Winelovers Webshop',   'https://wineloverswebshop.hu/',      'wineloverswebshop.hu',  'wine',   'woocommerce',    'platform_api',   'gentle', '#A03050', 40),
  ('borhalo',      'Borháló',              'https://www.borhalo.com/',           'www.borhalo.com',       'wine',   'generic-jsonld', 'sitemap',        'gentle', '#6E2639', 50),
  ('winehub',      'Winehub',              'https://winehub.hu/',                'winehub.hu',            'wine',   'shopify',        'platform_api',   'gentle', '#452030', 60),
  ('idrinks',      'iDrinks',              'https://idrinks.hu/',                'idrinks.hu',            'spirit', 'woocommerce',    'platform_api',   'gentle', '#1F3A5F', 70),
  ('whiskynet',    'WhiskyNet',            'https://www.whiskynet.hu/',          'www.whiskynet.hu',      'spirit', 'generic-jsonld', 'sitemap',        'gentle', '#8A5A22', 80),
  ('goodspirit',   'GoodSpirit',           'https://goodspirit.hu/',             'goodspirit.hu',         'spirit', 'generic-jsonld', 'sitemap',        'gentle', '#7A4A18', 90),
  ('mralkohol',    'Mr. Alkohol',          'https://www.mralkohol.hu/',          'www.mralkohol.hu',      'spirit', 'woocommerce',    'platform_api',   'gentle', '#2E4630', 100),
  ('italshop',     'Italshop',             'https://italshop.hu/',               'italshop.hu',           'spirit', 'woocommerce',    'platform_api',   'gentle', '#334455', 110)
) AS v(key, name, base_url, host, segment, adapter, strategy, policy, color, sort)
ON CONFLICT (key) DO UPDATE
  SET name = EXCLUDED.name, base_url = EXCLUDED.base_url, brand_color = EXCLUDED.brand_color, sort_order = EXCLUDED.sort_order;

-- ─── Identitáshordozó kifejezések (spec 10.4, 13.2) ────────────────────────
INSERT INTO identity_terms (term, term_class, category_id, contradiction_class, weight)
SELECT t.term, t.cls, (SELECT id FROM product_categories WHERE key = t.cat), t.contra, t.w
FROM (VALUES
  -- whisky / tömény expressionök
  ('black label','expression', 'whisky','expression', 1.0),
  ('double black','expression','whisky','expression', 1.0),
  ('gold reserve','expression','whisky','expression', 1.0),
  ('blue label','expression','whisky','expression', 1.0),
  ('green label','expression','whisky','expression', 1.0),
  ('red label','expression','whisky','expression', 1.0),
  ('cask strength','strength','whisky','strength', 1.0),
  ('single cask','edition','whisky','edition', 1.0),
  ('small batch','edition','whisky','edition', 0.9),
  ('single malt','style','whisky','style', 0.8),
  ('blended','style','whisky','style', 0.8),
  ('sherry cask','cask','whisky','cask', 1.0),
  ('port cask','cask','whisky','cask', 1.0),
  ('rum cask','cask','whisky','cask', 1.0),
  ('distillers edition','edition','whisky','edition', 1.0),
  ('limited edition','edition','whisky','edition', 0.9),
  ('reserve','edition','whisky','edition', 0.9),
  ('special reserve','edition','whisky','edition', 1.0),
  -- konyak
  ('vs','age','cognac','age', 1.0),
  ('vsop','age','cognac','age', 1.0),
  ('xo','age','cognac','age', 1.0),
  ('napoleon','age','cognac','age', 1.0),
  ('extra','age','cognac','age', 0.9),
  -- gin
  ('sloe','expression','gin','expression', 1.0),
  ('london dry','style','gin','style', 0.9),
  ('navy strength','strength','gin','strength', 1.0),
  ('old tom','style','gin','style', 1.0),
  -- rum
  ('anejo','age','rum','age', 0.9),
  ('blanco','style','rum','style', 0.9),
  ('overproof','strength','rum','strength', 1.0),
  ('solera','style','rum','style', 0.9),
  -- pezsgő dosage
  ('brut','dosage','sparkling_wine','dosage', 1.0),
  ('extra brut','dosage','sparkling_wine','dosage', 1.0),
  ('brut nature','dosage','sparkling_wine','dosage', 1.0),
  ('demi sec','dosage','sparkling_wine','dosage', 1.0),
  ('doux','dosage','sparkling_wine','dosage', 1.0),
  ('sec','dosage','sparkling_wine','dosage', 1.0),
  ('rose','colour','sparkling_wine','colour', 1.0),
  ('blanc de blancs','style','sparkling_wine','style', 1.0),
  ('blanc de noirs','style','sparkling_wine','style', 1.0),
  -- champagne
  ('brut','dosage','champagne','dosage', 1.0),
  ('extra brut','dosage','champagne','dosage', 1.0),
  ('millesime','edition','champagne','edition', 1.0),
  -- bor
  ('szaraz','sweetness','wine','sweetness', 0.8),
  ('felszaraz','sweetness','wine','sweetness', 0.8),
  ('feledes','sweetness','wine','sweetness', 0.8),
  ('edes','sweetness','wine','sweetness', 0.8),
  ('kesoi szuretelesu','edition','wine','edition', 1.0),
  ('jegbor','edition','wine','edition', 1.0),
  ('bio','edition','wine','edition', 0.9),
  ('natur','edition','wine','edition', 0.9),
  ('barrique','cask','wine','cask', 0.9),
  ('valogatas','edition','wine','edition', 0.9),
  ('szamorodni','expression','tokaji_aszu','expression', 1.0),
  ('3 puttonyos','puttony','tokaji_aszu','puttony', 1.0),
  ('4 puttonyos','puttony','tokaji_aszu','puttony', 1.0),
  ('5 puttonyos','puttony','tokaji_aszu','puttony', 1.0),
  ('6 puttonyos','puttony','tokaji_aszu','puttony', 1.0),
  ('eszencia','expression','tokaji_aszu','expression', 1.0),
  -- pálinka
  ('agyas','edition','palinka','edition', 1.0),
  ('erlelt','edition','palinka','edition', 1.0),
  ('hordos','edition','palinka','edition', 1.0),
  ('premium','edition','palinka','edition', 0.8),
  -- csomagolás (globális)
  ('diszdoboz','packaging',NULL,'packaging', 1.0),
  ('ajandekdoboz','packaging',NULL,'packaging', 1.0),
  ('fadoboz','packaging',NULL,'packaging', 1.0),
  ('gift box','packaging',NULL,'packaging', 1.0),
  ('gift pack','packaging',NULL,'packaging', 1.0),
  ('magnum','packaging',NULL,'packaging', 1.0),
  ('dupla magnum','packaging',NULL,'packaging', 1.0)
) AS t(term, cls, cat, contra, w)
ON CONFLICT DO NOTHING;

-- ─── Negatív aliasok: a történelmi hibák szabályosítva (spec 32.2) ─────────
INSERT INTO negative_aliases (left_text, right_text, category_id, reason)
SELECT n.l, n.r, (SELECT id FROM product_categories WHERE key = n.cat), n.reason
FROM (VALUES
  ('black label','double black','whisky','Két külön Johnnie Walker expression (spec 3.1).'),
  ('black label','gold reserve','whisky','Külön expression.'),
  ('red label','black label','whisky','Külön expression.'),
  ('gin','sloe gin','gin','A Sloe Gin nem azonos a sima ginnel.'),
  ('vs','vsop','cognac','Eltérő korjelölés.'),
  ('vsop','xo','cognac','Eltérő korjelölés.'),
  ('brut','demi sec','sparkling_wine','Eltérő dosage.'),
  ('brut','extra brut','sparkling_wine','Eltérő dosage.'),
  ('5 puttonyos','6 puttonyos','tokaji_aszu','Eltérő puttonyszám (spec 3.1).'),
  ('szamorodni','aszu','tokaji_aszu','Eltérő tokaji borkategória.')
) AS n(l, r, cat, reason)
ON CONFLICT DO NOTHING;

-- ─── Alapbeállítások (spec 28.) ────────────────────────────────────────────
INSERT INTO settings (key, version, value, description, requires_approval, active) VALUES
('matching.thresholds', 1,
 '{"autoMatch":{"evidenceCoverage":0.90,"extractionQuality":0.90,"agreementScore":0.96,"topMargin":0.10},
   "review":{"minScore":0.70},
   "ambiguousMargin":0.03,
   "volumeToleranceMl":5}'::jsonb,
 'Automatikus párosítási küszöbök (spec 15.6). Módosítás csak golden kiértékelés után.', true, true),

('matching.field_weights', 1,
 '{"producer":0.18,"expression":0.28,"vintage":0.16,"volume":0.16,"category":0.06,
   "region":0.06,"abv":0.04,"gtin":0.04,"image":0.02}'::jsonb,
 'Mezősúlyok a jelöltrangsoroláshoz (spec 15.5). Kezdőértékek, kalibrálandók.', true, true),

('matching.candidate_limits', 1,
 '{"perChannelTopN":25,"totalTopN":60,"trigramMinSimilarity":0.32,"ftsRankMin":0.02}'::jsonb,
 'Jelöltgenerálási korlátok (spec 14.3).', false, true),

('pricing.comparison', 1,
 '{"currency":"HUF","vatIncluded":true,"allowedPriceTypes":["regular","sale"],
   "excludeMemberOnly":true,"excludeCouponOnly":true,"excludeQuantityOnly":true,
   "includeOutOfStockInRank":false,"freshnessMaxHours":240}'::jsonb,
 'Az összehasonlítható alapár definíciója (spec 18.2).', false, true),

('pricing.anomaly', 1,
 '{"significantChangePct":15,"extremeChangePct":60,"magnitudeFactor":8,
   "minPlausiblePriceHuf":500,"maxPlausiblePriceHuf":8000000,"quarantineOnExtreme":true}'::jsonb,
 'Árenomália-küszöbök (spec 18.4).', false, true),

('search.retry_schedule', 1,
 '{"immediateOnCreate":true,"technicalFailureRetryHours":24,
   "healthyNoMatchWeeklyForWeeks":4,"longTermMonthly":true}'::jsonb,
 'Nem talált termékek újrakeresési ütemezése (spec 16.2).', false, true),

('quality_gate.shop', 1,
 '{"maxCatalogDropPct":20,"minParserSuccessRate":0.85,"maxMatchCoverageDropPct":15,
   "requireSchemaValid":true,"allowPartialPublish":true}'::jsonb,
 'Webshoponkénti quality gate (spec 31.1).', true, true),

('review.sla', 1,
 '{"driftHours":24,"newMatchHours":72,"ambiguousHours":72,"priceAnomalyHours":24}'::jsonb,
 'Review SLA órákban (spec 28.).', false, true),

('retention', 1,
 '{"rawArtifactDays":60,"snapshotDays":400,"observationDays":1100,"metricDays":180,"auditDays":2000}'::jsonb,
 'Adatmegőrzés (spec 29.3).', true, true),

('taxonomy.version', 1, '"1.0.0"'::jsonb, 'Aktív taxonómia-verzió.', false, true),
('matcher.version', 1, '"2.1.0"'::jsonb, 'Aktív matcher-verzió.', false, true),
('policy.version', 1, '"2.1.0"'::jsonb, 'Aktív döntési policy verzió.', false, true)
ON CONFLICT (key, version) DO NOTHING;

-- ─── Feature flagek (spec 15.6, 36.4) ─────────────────────────────────────
INSERT INTO feature_flags (key, enabled, description) VALUES
('auto_match', false, 'Automatikus párosítás engedélyezése. Pilotban KIKAPCSOLVA (spec 15.6).'),
('auto_match_identifier_only', true, 'Ha az auto_match aktív: csak exact platform ID / GTIN + minden kötelező mező egyezése esetén.'),
('embeddings', false, 'Opcionális embedding-alapú jelölt-visszakeresés (spec 14.1/E).'),
('browser_crawler', true, 'Playwright alapú böngészős crawler engedélyezése.'),
('ai_extraction', false, 'AI-alapú, bizonyítékkötött mezőkinyerés (spec 12.4).'),
('external_websearch', false, 'Külső kereső API használata jelölt-URL felderítésre (spec 14.1/G).'),
('auto_publish', true, 'Sikeres quality gate után automatikus piaci publikáció.')
ON CONFLICT (key) DO NOTHING;
