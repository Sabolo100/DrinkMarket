-- ============================================================================
-- 0017  A jóváhagyás hatályba léptetése a katalóguson
--
-- Egy borászat jóváhagyása önmagában NEM változtat semmit a már begyűjtött
-- terméklistán: a `source_listings.producer_id` üresen marad, amíg valaki
-- újra ki nem nyeri az azonosságot a tárolt névből. Eddig ehhez egy teljes
-- újracrawlra kellett várni — pedig a névhez nem kell a webshop, csak a
-- szótár.
--
-- Ez a két oszlop teszi láthatóvá, hogy egy jóváhagyás már hatályba lépett-e.
-- Enélkül a felületen nem lehet megkülönböztetni a „jóváhagytam, de még nem
-- hatott" és a „lefutott, de nincs rá termék" állapotot — pedig a kettő
-- teljesen más teendőt jelent.
-- ============================================================================

ALTER TABLE producers
  ADD COLUMN IF NOT EXISTS applied_at            timestamptz,
  ADD COLUMN IF NOT EXISTS applied_listing_count integer NOT NULL DEFAULT 0;

COMMENT ON COLUMN producers.applied_at IS
  'Mikor futott le utoljára az újrakinyerés erre a borászatra. NULL = a jóváhagyás még nem hatott a katalógusra.';
COMMENT ON COLUMN producers.applied_listing_count IS
  'Hány listingen ismerte fel az utolsó újrakinyerés ezt a borászatot.';

-- A jóváhagyott, de még nem alkalmazott borászatok listája — ezt kérdezi le a
-- felület és a kötegelt alkalmazás.
CREATE INDEX IF NOT EXISTS producers_unapplied_idx
  ON producers (decided_at)
  WHERE status = 'active' AND applied_at IS NULL;
