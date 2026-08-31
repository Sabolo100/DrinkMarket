# Adapter runbook — `<webshop neve>`

> Ez a sablon a spec 33. fejezetének kötelező onboarding eljárását követi.
> Minden új webshophoz ki kell tölteni, **mielőtt** az adapter élesbe kerül.
> A kitöltött runbookot a `docs/adapter-runbooks/<shop-key>.md` néven mentsd.

---

## 1. Azonosítás

| Mező | Érték |
| --- | --- |
| Shop key | `` |
| Megjelenítendő név | |
| Kanonikus host | |
| Alternatív hostok | |
| Szegmens | bor / tömény / vegyes |
| Felmérés dátuma | |
| Felmérést végezte | |

---

## 2. Forrásfelmérés (spec 33.1)

**Ne feltételezd, hogy a korábban tapasztalt megoldás ma is működik.**
Minden pontot élőben kell ellenőrizni.

| Vizsgálat | Eredmény | Megjegyzés |
| --- | --- | --- |
| Platform / CMS | | pl. WooCommerce 8.x, Shopify, UNAS, ShopRenter |
| `robots.txt` | | mit tilt, van-e crawl-delay |
| Felhasználási feltételek | | van-e automatizált hozzáférést érintő kikötés |
| XML sitemap | | URL(-ek), termék-sitemap külön van-e |
| Termékfeed / API | | pl. `/wp-json/wc/store/v1/products`, `/products.json` |
| JSON-LD `Product` | | teljes-e (név, ár, GTIN, availability) |
| Beágyazott app state | | `__NEXT_DATA__`, `window.__NUXT__`, platform meta |
| Kategóriaoldalak | | lapozás módja, oldalankénti elemszám |
| Belső kereső | | URL-sablon, eredmény szerkezete |
| Variánskezelés | | egy oldal több eladható változattal? |
| Ár- és készletmodell | | normál / akciós / klub / kuponos ár elkülönül-e |
| **Ár mértékegysége** | | **egész HUF vagy minor unit? Ne feltételezd!** |
| Age gate / cookie banner | | blokkolja-e a tartalmat |
| Dinamikus renderelés | | kell-e böngésző, vagy elég a HTTP |
| Stabil product/variant ID | | van-e, hol található |
| Kanonikus URL / redirect | | `rel=canonical` megbízható-e |
| Várható katalógusméret | | darabszám becslés + forrás |

### Ár mértékegysége — külön ellenőrzés

A spec 12.3 kifejezetten tiltja, hogy az árat fixen 100-zal osszuk.
Írd le, **konkrét példával**, hogyan érkezik az ár:

```
Példa termék:      <URL>
Nyers érték:       <pl. "prices":{"price":"1149000","currency_minor_unit":2}>
Levezetés:         1149000 / 10^2 = 11 490 Ft
Ellenőrzés:        a termékoldalon látható ár: 11 490 Ft  ✔
```

---

## 3. Adapterterv (spec 33.2)

| Kérdés | Válasz |
| --- | --- |
| Választott adapter | `woocommerce` / `shopify` / `generic-jsonld` / `browser-jsonld` / egyedi |
| Felderítési út | |
| Fallback út | |
| Detail extraction út | |
| Keresési út | |
| Rate limit (kérés/mp) | |
| Párhuzamosság | |
| Health check URL | |
| Teljességi bizonyíték | pl. `X-WP-Total` fejléc, sitemap elemszám |
| Ismert korlátok | |

### `adapter_config` javaslat

```json
{
  "sitemapUrls": [],
  "productUrlInclude": [],
  "productUrlExclude": [],
  "searchUrlTemplate": "",
  "healthCheckUrl": "",
  "minorUnitHint": 0,
  "urlRule": { "keepParams": ["variant"], "dropUnknownParams": false }
}
```

---

## 4. Jogi és policy státusz (spec 29.2)

| Kérdés | Válasz |
| --- | --- |
| Nyilvánosan elérhető-e az adat? | |
| Mit enged a `robots.txt`? | |
| Mit ír a felhasználási feltétel? | |
| Milyen lekérési gyakoriság arányos? | |
| Milyen adatot tárolunk, meddig? | |
| Eltávolítási kérés kezelése | |
| Szükséges-e külön megállapodás? | |
| **`legal_review_status`** | `pending` / `approved` / `restricted` / `blocked` |

> A `robots.txt` technikai protokoll, **nem** teljes jogi engedély.
> Ha a jogi státusz nem tisztázott, a forrás `policy_disabled` marad — és ez
> **soha** nem jelenik meg „nincs ilyen termék” eredményként a felületen.

---

## 5. Definition of Done (spec 33.3)

- [ ] Fixture tesztek: normál katalógus, normál termékoldal, lapozás,
      üres/megváltozott szerkezet, hibás ár, redirect, challenge/age gate,
      több variáns, JSON-LD és látható ár ellentmondása
- [ ] Live smoke teszt lefutott
- [ ] Legalább egy **teljes** katalógusfutás lefutott
- [ ] Candidate count baseline rögzítve
- [ ] Ár és variáns ellenőrizve **legalább 20 mintán**, kézzel
- [ ] Hibás szerkezet felismerése `parse_error`-t ad, **nem** `not_found`-ot
- [ ] Retry / timeout mérhető
- [ ] Dashboard health megjelenik
- [ ] Ez a runbook kitöltve és beadva

### 20 mintás ár-ellenőrzés

| # | Termék-URL | Látható ár | Kinyert ár | Variáns OK? | Megjegyzés |
| --- | --- | --- | --- | --- | --- |
| 1 | | | | | |
| 2 | | | | | |

---

## 6. Baseline mérőszámok

| Mérőszám | Érték | Mérés dátuma |
| --- | --- | --- |
| Katalógusméret | | |
| Discovery futásidő | | |
| Kinyerési siker aránya | | |
| Átlagos jelöltszám | | |
| `candidate_recall@10` | | |

---

## 7. Ismert problémák és nyitott kockázatok

| Probléma | Hatás | Kezelés |
| --- | --- | --- |
| | | |
