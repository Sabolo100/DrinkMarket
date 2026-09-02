-- ============================================================================
-- 0015  Visszalépés a sikertelen felderítés után
--
-- A `next_discovery_at` mezőt eddig CSAK a normál befejezési út tolta előre.
-- A kivétellel leálló ág nem, és a megszakadt futásokat lezáró reaper sem.
--
-- Következmény: ha egy futás megszakadt, a bolt `next_discovery_at`-je a
-- múltban maradt, és az ütemező MINDEN körben — percenként — újra beküldte.
-- Élesben ez egyetlen éjszaka alatt ~6 óra crawlolást jelentett egyetlen
-- forrásra, ami után a webshop szervere blokkolni kezdett minket.
--
-- Ez a számláló teszi láthatóvá és fékezhetővé a jelenséget: minden
-- sikertelen felderítés növeli, a sikeres nullázza, és a következő futás
-- időpontja ehhez igazodik.
-- ============================================================================

ALTER TABLE shops
  ADD COLUMN IF NOT EXISTS consecutive_discovery_failures integer NOT NULL DEFAULT 0;

COMMENT ON COLUMN shops.consecutive_discovery_failures IS
  'Egymás utáni sikertelen katalógus-felderítések száma. A sikeres futás nullázza. A következő futás időpontja ehhez igazodó visszalépést kap.';
