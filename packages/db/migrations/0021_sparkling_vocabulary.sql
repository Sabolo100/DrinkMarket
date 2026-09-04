-- ---------------------------------------------------------------------------
-- 0021 — A pezsgő felismerésének kiszélesítése
--
-- A 0020 utáni szabály a bortípusból vezeti le a kategóriát: ha a stílus
-- `sparkling`, a listing `sparkling_wine` besorolást kap, és onnantól a
-- kategória-összehasonlítás kizárja a csendes borokat.
--
-- A szabály viszont csak annyit ér, amennyit a szótár felismer. Ma hat alak
-- van bent — `pezsgo`, `sparkling`, `habzóbor`, `spumante`, `frizzante`,
-- `perlwein` —, és ezek közül a webshopok terméknevében jellemzően EGY sem
-- szerepel. Ami szerepel: „Brut", „Brut Nature", „Extra Dry", „Prosecco",
-- „Cava", „Crémant".
--
-- A felhasználó példája — „Sauska Brut Nature N.V pezsgő (0,75l)" — csak
-- azért oldódott fel, mert a bolt kiírta a „pezsgő" szót is. A
-- „Sauska Brut Nature N.V." alak nem oldódott volna fel, és a kategória-kapu
-- ott továbbra sem tüzelne.
--
-- Az itt felvett alakok mind EGYÉRTELMŰEK: dozázs-megjelölések és pezsgő-
-- típusnevek, amelyek csendes boron nem fordulnak elő. Ahol kétség lenne
-- (pl. „sec", „dry" önmagában), oda nem nyúlunk — az a szótár bővítése
-- helyett hamis besorolást termelne.
-- ---------------------------------------------------------------------------

INSERT INTO aliases (alias_type, alias_text, target_kind, target_id, source, approved, active, evidence)
SELECT 'wine_style', v.alias, 'wine_style', s.id, 'import', true, true,
       '[{"kind":"seed","note":"0021 pezsgo-szokincs"}]'::jsonb
  FROM wine_styles s
  CROSS JOIN (VALUES
    -- dozázs (a pezsgő édességi skálája) — csendes boron nem használt
    ('brut'),
    ('brut nature'),
    ('brut natur'),
    ('extra brut'),
    ('extra dry'),
    ('dosage zero'),
    ('zero dosage'),
    ('pas dose'),
    ('demi sec'),
    -- pezsgő-típusnevek
    ('prosecco'),
    ('cava'),
    ('cremant'),
    ('sekt'),
    ('franciacorta'),
    ('asti'),
    ('lambrusco'),
    -- készítési mód és stílusjelölés, ami csak pezsgőn fordul elő
    ('methode traditionnelle'),
    ('metodo classico'),
    ('blanc de blancs'),
    ('blanc de noirs')
  ) AS v(alias)
 WHERE s.key = 'sparkling'
ON CONFLICT DO NOTHING;

-- A gyöngyöző saját, szűkebb szókincse.
INSERT INTO aliases (alias_type, alias_text, target_kind, target_id, source, approved, active, evidence)
SELECT 'wine_style', v.alias, 'wine_style', s.id, 'import', true, true,
       '[{"kind":"seed","note":"0021 gyongyozo-szokincs"}]'::jsonb
  FROM wine_styles s
  CROSS JOIN (VALUES ('petnat'), ('pet nat'), ('petillant naturel'), ('vinho verde')) AS v(alias)
 WHERE s.key = 'semi_sparkling'
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------------
-- A már eltárolt besorolások NEM itt javulnak.
--
-- Ez a migráció csak a szótárt bővíti. Ahhoz, hogy a katalóguson is hasson,
-- egy újrakinyerésnek kell végigmennie a már begyűjtött neveken:
--
--   Borászatok → Teljes újrakinyerés
--
-- Ez az a lépés, ami a listingek `category_id`-ját a helyes értékre állítja,
-- és amitől a pezsgő mellől eltűnnek a csendes borok.
-- ---------------------------------------------------------------------------
