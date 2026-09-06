-- ─────────────────────────────────────────────────────────────────────────────
-- A winehub NEM Shopify: WooCommerce.
--
-- A seedben `shopify` adapterrel szerepelt. A Shopify-ut (/products.json) ezen
-- a bolton HTML-t ad 404-gyel, tehat a platform-ag SOHA nem mukodott - a
-- rendszer csendben visszaesett a HTML/JSON-LD olvasasra. Innen ered a
-- 15 000 Ft-os fantomar: a szallitasi kuszobot olvastuk arkent 3 661 termeken.
--
-- A valosag (2026-09-06, meresbol):
--   meta generator            WooCommerce 10.7.0 / WordPress
--   /wp-json/wc/store/v1/...  HTTP 200, strukturalt arak
--   Borbely Rozsako 2024      5 000 Ft   (nem 15 000)
--   Folly Olaszrizling 2024   3 990 Ft   (nem 15 000)
--
-- A Store API `currency_minor_unit: 0`-t ad HUF-ra, es a WooCommerce adapter
-- ezt mar helyesen kezeli.
--
-- ─── Miert `lang=hu`? ────────────────────────────────────────────────────────
--
-- A bolt ketnyelvu, es a ket katalogus KULON termekazonositokat hasznal:
--
--   parameter nelkul   2 921 termek   (mindketto egyszerre)
--   lang=hu            1 438 termek   /termek/...
--   lang=en            1 483 termek   /en/termek/...
--
-- Parameter nelkul minden bor ketszer kerulne be, ket kulon URL-en, ugyanabban
-- a boltban - pontosan az a duplikacio, ami a parositasnal ket egyforma
-- jeloltkent jelenne meg. A magyar piacra a magyar katalogus a helyes.
--
-- ─── Mit NEM tesz ez a migracio ──────────────────────────────────────────────
--
-- Nem nyul a meglevo listingekhez es nem torol arat. A valodi arak az elso
-- felderites utan erkeznek; addig a 15 000 Ft-os sorok "nem osszehasonlithato"
-- jeloléssel allnak, tehat a piaci oldalra nem kerulnek ki.
-- ─────────────────────────────────────────────────────────────────────────────

UPDATE shops
   SET adapter_key    = 'woocommerce',
       adapter_config = COALESCE(adapter_config, '{}'::jsonb)
                        || '{"platformApiParams": {"lang": "hu"}}'::jsonb
 WHERE key = 'winehub'
   AND adapter_key <> 'woocommerce';
