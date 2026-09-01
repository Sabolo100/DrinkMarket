-- ============================================================================
-- 0013  A katalógus-felderítés folytatási pontja
--
-- A felderítés futásonként időkorlátos (WORKER_MAX_RUN_MINUTES, alap 40 perc).
-- A `gentle` crawl policy 0,5 kérés/mp üteme mellett ez pontosan 1200 kérés —
-- ezért állt meg több boltnál is ~1198 terméknél.
--
-- A valódi baj nem a korlát volt, hanem hogy a futás MINDIG a céllista
-- elejéről indult: a következő futás ugyanazt az első 1200 terméket töltötte
-- le újra, és a katalógus hátralévő része soha nem került sorra. Egy 3000
-- termékes bolt tartósan 1200-nál ragadt.
--
-- Két oszlop old meg mindkét következményt:
--
--   discovery_resume_url    Hol hagytuk abba. A következő futás innen indul,
--                           és a lista végén körbefordul. Szándékosan URL és
--                           nem index: a céllista két futás között változhat,
--                           egy eltolódott index néma átugrást okozna.
--
--   discovery_cycle_started_at
--                           Mikor kezdődött a jelenlegi teljes kör. Az eltűnt
--                           termékek jelölése eddig csak egyetlen teljes futás
--                           után volt biztonságos; körkörös feldolgozásnál a
--                           helyes összehasonlítási alap a KÖR kezdete.
-- ============================================================================

ALTER TABLE shops
  ADD COLUMN IF NOT EXISTS discovery_resume_url       text,
  ADD COLUMN IF NOT EXISTS discovery_cycle_started_at timestamptz;

COMMENT ON COLUMN shops.discovery_resume_url IS
  'A céllista URL-je, ahol az előző felderítés az időkorlát miatt megállt. NULL = a következő futás az elejéről indul.';
COMMENT ON COLUMN shops.discovery_cycle_started_at IS
  'A jelenlegi teljes katalógus-kör kezdete. Az eltűnt listingek jelölése ehhez viszonyít.';
