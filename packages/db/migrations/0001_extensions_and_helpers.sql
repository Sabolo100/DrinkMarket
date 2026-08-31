-- ============================================================================
-- 0001  Kiterjesztések, séma-szintű segédfüggvények
-- ----------------------------------------------------------------------------
-- Coolify / managed Postgres: a CREATE EXTENSION superuser vagy a megfelelő
-- jogosultsággal rendelkező owner alatt fut. Ha egy extension nem hozható létre,
-- a migráció szándékosan elhasal, mert a matching működése függ tőlük.
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS "pgcrypto";      -- gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS "pg_trgm";       -- trigram hasonlóság a jelöltkereséshez
CREATE EXTENSION IF NOT EXISTS "unaccent";      -- ékezetmentes keresési reprezentáció
CREATE EXTENSION IF NOT EXISTS "btree_gin";     -- vegyes GIN indexek

-- ---------------------------------------------------------------------------
-- Ékezetmentesítő, IMMUTABLE wrapper. Az unaccent() alapból STABLE, ezért
-- generated column / kifejezésindex nem használhatná közvetlenül.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION rv_unaccent(text)
RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT AS
$$ SELECT public.unaccent('public.unaccent'::regdictionary, $1) $$;

-- ---------------------------------------------------------------------------
-- Keresési normalizálás: kisbetű + ékezetmentes + tipográfiai karakterek
-- egységesítése + többszörös szóköz összevonása.
-- FONTOS: ez csak visszakeresési reprezentáció. A nyers nevet SOHA nem
-- helyettesíti (spec 13.1).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION rv_search_norm(text)
RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS
$$
  SELECT NULLIF(
    btrim(
      regexp_replace(
        regexp_replace(
          lower(rv_unaccent(translate(coalesce($1, ''),
            E'\u2018\u2019\u201B\u02BC\u201C\u201D\u2013\u2014\u2212\u00A0\u00D7',
            '''''''''""---  x'))),
          '[^a-z0-9%.,]+', ' ', 'g'),
        '\s+', ' ', 'g')
    ), '');
$$;

-- ---------------------------------------------------------------------------
-- Magyar + egyszerű ('simple') vegyes FTS vektor. A 'simple' konfiguráció
-- azért kell, mert az italnevek nagy része idegen szó, amit a magyar stemmer
-- elronthat (pl. "Reserve" -> "reserv"). A két vektor összefűzve indexelődik.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION rv_tsv(text)
RETURNS tsvector
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS
$$ SELECT to_tsvector('simple', coalesce(rv_search_norm($1), '')) $$;

-- ---------------------------------------------------------------------------
-- updated_at trigger
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION rv_touch_updated_at()
RETURNS trigger LANGUAGE plpgsql AS
$$ BEGIN NEW.updated_at = now(); RETURN NEW; END $$;
