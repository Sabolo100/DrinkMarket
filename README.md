# RADOVIN Ár-intelligencia

**Webshopközi italár-figyelő és termékazonosító rendszer** — a
`RADOVIN_PRICE_INTELLIGENCE_SYSTEM_SPEC_V2_HU.md` (V2.1) megvalósítása.

A rendszer nem ár-scraper. Négy, egymástól elkülönített feladatot old meg:

1. **Kanonikus termékkatalógus** — webshopoktól független, pontos
   termékváltozatok (évjárat, kiszerelés, darabszám, csomagolás, kiadás).
2. **Piaci termékfelderítés** — a bevont webshopok katalógusának rendszeres,
   forrásfüggő feltérképezése; **minden** megtalált listing bekerül.
3. **Webshopközi termékazonosítás** — bizonyítékalapú párosítás, amely
   **tartózkodni is tud**.
4. **Árfigyelés és megjelenítés** — ártörténet, piaci pozíció, rang, szóródás.

> **A rendszer legfontosabb tulajdonsága, hogy meg tud állni.**
> Inkább jelez bizonytalanságot és kér emberi döntést, mint hogy egy hasonló,
> de eltérő évjáratú, kiszerelésű vagy csomagolású termék árát mutassa.

---

## Tartalom

- [Gyors indítás](#gyors-indítás)
- [Telepítés Coolify-ra](#telepítés-coolify-ra)
- [Architektúra](#architektúra)
- [Adatbázis](#adatbázis)
- [A párosítás működése](#a-párosítás-működése)
- [Webshop hozzáadása](#webshop-hozzáadása)
- [Tesztelés](#tesztelés)
- [Üzemeltetés](#üzemeltetés)
- [Biztonság és jogi keret](#biztonság-és-jogi-keret)

---

## Gyors indítás

Szükséges: Node 22+, Docker.

```bash
npm install
```

Indíts egy Postgres és egy Redis példányt:

```bash
docker compose up -d postgres redis
```

Készítsd el a `.env` fájlt a minta alapján, és generálj session titkot:

```bash
cp .env.example .env && openssl rand -hex 32
```

Futtasd a migrációkat (ez tölti be a referenciaadatokat is):

```bash
npm run db:migrate
```

Indítsd a szolgáltatásokat külön terminálokban:

```bash
npm run dev:api
```

```bash
npm run dev:worker
```

```bash
npm run dev:web
```

A felület a `http://localhost:3000` címen érhető el. Az első belépéshez állítsd
be a `BOOTSTRAP_ADMIN_EMAIL` és `BOOTSTRAP_ADMIN_PASSWORD` változókat — az API
induláskor létrehozza az admin fiókot, ha még egyetlen felhasználó sincs.

**Demo-adatok** betöltése (valós webshopnevek, kitalált árak, élő letöltés
nélkül):

```bash
npm run seed:demo
```

---

## Telepítés Coolify-ra

A `docker-compose.coolify.yml` azt feltételezi, hogy a **PostgreSQL és a Redis
külön, Coolify által kezelt resource** — így a mentés és a visszaállítás a
Coolify saját eszközeivel történik.

1. **PostgreSQL 16 resource** létrehozása. Az *Internal URL* → `DATABASE_URL`.
   A `pgcrypto`, `pg_trgm`, `unaccent` és `btree_gin` kiterjesztéseket az első
   migráció hozza létre; ehhez a DB-felhasználónak jogosultság kell (a Coolify
   alapértelmezett superuserével ez adott).
2. **Redis resource** létrehozása. Az *Internal URL* → `REDIS_URL`.
3. A projektben állítsd be a Docker Compose fájlt a `docker-compose.coolify.yml`
   értékre.
4. Töltsd ki a környezeti változókat. **Kötelező:** `DATABASE_URL`, `REDIS_URL`,
   `SESSION_SECRET`, `APP_BASE_URL`, `BOOTSTRAP_ADMIN_EMAIL`,
   `BOOTSTRAP_ADMIN_PASSWORD`.
5. A **`web`** szolgáltatásra kösd a domaint (3000-es port). Az `api` **nem**
   igényel publikus domaint — a web a belső hálózaton éri el, és a böngésző
   azonos originről hívja a `/api/*` útvonalat.
6. Első belépés után **azonnal változtass jelszót** a felületen.

A migrációk az `api` induláskor futnak le, Postgres advisory lock alatt — több
példány egyidejű indítása sem okoz ütközést.

A **böngészős worker opcionális**: csak akkor kell, ha valamelyik forrásnál
nincs stabil HTTP/JSON út. Nagy image, külön erőforráskerettel fut.

---

## Architektúra

```
apps/
  api/         Fastify API — auth, RBAC, üzleti végpontok, audit
  worker/      BullMQ workerek — crawl, kinyerés, párosítás, publikáció
  scheduler/   Ütemező — jobokat hoz létre, üzleti munkát nem végez
  web/         Next.js felület (szerverkomponensek + szerveroldali szűrés)
packages/
  contracts/      közös típusszerződések (adapter, evidence, match)
  domain/         normalizálás, identitás, matching, pricing, taxonómia
  extraction/     JSON-LD, microdata, platform state, ár, sitemap
  crawler-core/   robots, SSRF, rate limit, backoff, válaszminőség
  adapters/       adapter-szerződés + shop adapterek
  db/             migrációk, pool, migrátor, CLI
  observability/  strukturált log, metrikák, AppError
```

**Rétegszabályok** (spec 38.):

- Az **adapter nem párosít**, a **matcher nem crawlol**.
- Webshop-specifikus szelektor vagy kód **soha** nem kerül a központi
  párosítóba, sem a felületbe.
- A hard gate-eket a pontszám **nem írhatja felül**.
- Az `unknown` **soha** nem alakul `match`-csé.

Új webshop egy adapterkulccsal és konfigurációval hozzáadható a párosító és a
frontend átírása nélkül.

---

## Adatbázis

PostgreSQL 16, **42 tábla**, 9 verziózott migráció. Minden migráció idempotens
és advisory lock alatt fut.

```bash
npm run db:status    # mely migrációk futottak le
npm run db:migrate   # hiányzók lefuttatása
npm run db:seed      # referenciaadatok ellenőrzése
npm run db:reset     # TELJES újraépítés (fejlesztéshez)
```

### Fő entitások

| Tábla | Szerep |
| --- | --- |
| `product_families` / `canonical_variants` | webshopfüggetlen termékcsalád és a **tényleges összehasonlítási egység** |
| `tracked_products` | opcionális figyelőlista — az összehasonlíthatóság **nem** függ tőle |
| `shops` | webshopok; a RADOVIN **egy a többi közül**, nincs kiemelt szerepe |
| `source_listings` | minden megtalált webshoptermék, párosítástól függetlenül |
| `source_listing_snapshots` | letöltésenkénti kinyert állapot, mezőnkénti bizonyítékkal |
| `offer_observations` | ártípusonként külön mezők, egész HUF-ban |
| `match_relations` / `match_decisions` | verziózott kapcsolat és magyarázható döntés |
| `review_cases` | emberi döntést igénylő esetek, optimistic lockinggal |
| `rejected_candidates` | negatív memória fingerprinttel |
| `search_attempts` | keresési memória: mikor, mivel, milyen úton kerestünk |
| `market_publications` / `market_offers` | **atomikusan publikált** piaci pillanatkép |
| `audit_log` | csak bővíthető; UPDATE/DELETE trigger tiltja |

### Fontos integritási szabályok

- Egy `source_listing`-nek **legfeljebb egy** aktív `verified` kanonikus
  kapcsolata lehet (részleges egyedi index).
- Egy shopon **egyszerre egy** futó teljes discovery (részleges egyedi index).
- Egy futásban listingenként **egy** megfigyelés — az ismételt futás nem duplikál.
- Egyszerre **egy** `published` piaci generáció lehet.

> ⚠️ A `shops.last_discovery_run_id → crawl_runs` kör miatt a
> `TRUNCATE crawl_runs CASCADE` **a `shops` táblát is kiürítené**.
> Karbantartáskor előbb `UPDATE shops SET last_discovery_run_id = NULL`,
> utána `DELETE FROM crawl_runs`.

### Normalizálás

A `rv_search_norm()` SQL függvény és a `searchNorm()` TypeScript függvény
**azonos kimenetet ad** — enélkül a jelöltkeresés és a döntés eltérne. Ezt
teszt is őrzi.

---

## A párosítás működése

```
jelöltgenerálás (több csatorna)
        ↓
hard gate — kizáró ellentmondások
        ↓
háromállapotú mező-összehasonlítás (match / contradiction / unknown)
        ↓
pontozás: agreement, evidence coverage, extraction quality, top margin
        ↓
döntés: auto | review | ambiguous | nem bizonyítható | igazoltan nincs
```

**Jelöltcsatornák** (spec 14.1): már igazolt kapcsolat → GTIN/SKU → strukturált
blocking kulcsok több passzban → FTS → trigram → word similarity → alias →
(opcionálisan embedding, belső kereső, külső kereső).

**Kategóriafüggő identitásprofil** dönti el, mely mező `required`,
`contradiction_only`, `supporting` vagy `not_applicable`. Például:

- **bornál** az évjárat kötelező, és az EAN-egyezés **nem** oldja fel;
- **töményitalnál** a `Black Label` / `Double Black` külön expression;
- **tokaji aszúnál** az 5 és 6 puttonyos külön termék.

Az automatikus párosítás **feature flaggel védett**, és a pilotban
alapértelmezetten **kikapcsolt**. A kritikus küszöbök csak friss, sikeres
golden kiértékelés és admin jóváhagyás után módosíthatók.

---

## Webshop hozzáadása

1. **Forrásfelmérés** — `docs/adapter-runbooks/SABLON.md` kitöltése.
2. **Adapter kiválasztása.** Meglévők: `woocommerce`, `shopify`,
   `generic-jsonld` (sitemap + JSON-LD), `browser-jsonld` (csak végső esetben).
3. **Konfiguráció** a `shops.adapter_config` mezőben (sitemap URL-ek,
   termék-URL minták, keresési sablon, URL-kanonizálási szabály).
4. **Jogi ellenőrzés**: `legal_review_status` beállítása. Amíg `pending`, a
   forrás felderíthető, de a `policy_disabled` kapcsoló bármikor letiltja.
5. **Health check** és **fixture teszt**, majd egy teljes katalógusfutás.

Az adapterek egységes kimeneti szerződést adnak
(`NormalizedSourceListing`) — az adapter **nem hoz üzleti döntést**.

---

## Tesztelés

```bash
npm test
```

| Készlet | Mit bizonyít |
| --- | --- |
| `tests/unit/normalization` | mértékegység, csomag, évjárat, ár, piaci pozíció |
| `tests/unit/matching` | a spec 32.2 **kötelező történelmi regressziós esetei** |
| `tests/unit/guard` | challenge-felismerés; egészséges forrás nem lehet „blokkolt” |
| `tests/e2e/pipeline` | teljes lánc valós Postgres ellen |

Az e2e teszt kihagyja magát `TEST_DATABASE_URL` nélkül:

```bash
TEST_DATABASE_URL=postgres://... npm test
```

Külön bizonyítja, hogy a **hibás futás nem írja felül az utolsó jó
publikációt**, az ismételt futás nem duplikál, és az identitás-eltolódás
blokkolja az ár publikálását.

### Golden dataset

A párosítás nem javítható, ha nem mérjük külön a jelöltkeresés hibáját a
döntési hibától. A `golden_pairs` / `golden_evaluations` táblák és a
**Beállítások** felület ezt szolgálják. Célértékek (spec 32.4):

- `candidate_recall@10 ≥ 98%`
- automatikus párok precision ≥ 99,5% (konfidenciaintervallummal együtt)
- minden ismert hard negative 100%-ban elutasítva vagy review-ba küldve
- false positive üzleti tolerancia: **0**

---

## Üzemeltetés

### Munkafolyamatok

- **Ütemező** percenként ellenőrzi az esedékes felderítéseket, árfrissítéseket,
  health checkeket és újrakereséseket. Advisory lock alatt fut, több példány
  sem duplikál.
- **Minőségi kapu** webshoponként és globálisan. Bukás esetén **csak az adott
  forrás** kerül karanténba; a többi publikálható marad, a hibás forrásnál az
  utolsó jó adat marad látható, egyértelmű jelöléssel.
- **Riasztás** aggregált és cselekvésre alkalmas. Egyedi `not_found` **nem**
  generál riasztást — az review/dashboard feladat.

### Megfigyelhetőség

Minden log strukturált JSON, korrelációs azonosítóval. Cookie, auth header,
token és jelszó **soha** nem kerül naplóba (a `redact()` minden kimenetre lefut).

### Mentés

Az adatbázis mentése és visszaállítása a Coolify Postgres resource feladata.
Az objektumtárban csak hibaeseti bizonyítékok vannak, korlátozott
megőrzéssel (alapértelmezés 60 nap).

---

## Biztonság és jogi keret

- Szerveroldali hitelesítés, scrypt jelszóhash, `HttpOnly`+`Secure`+`SameSite`
  cookie, CSRF token minden módosító kérésnél, szerepkör-ellenőrzés **minden**
  végponton (az olvasásiakat is beleértve).
- **SSRF-védelem**: a crawler nem érhet el privát IP-tartományt, metadata
  endpointot vagy belső hostot; felhasználói URL csak regisztrált webshop
  hostjára mutathat, kizárólag http/https protokollon.
- `robots.txt` feldolgozás az RFC 9309 szerint, forrásonkénti rate limit,
  `Retry-After` tiszteletben tartása, exponenciális backoff jitterrel.
- **CAPTCHA-megkerülés, proxyrotációs védelemkikerülés és belépés mögötti
  adatgyűjtés nincs.** Ha egy forrás blokkol, a rendszer `blocked` vagy
  `policy_disabled` állapotba kerül — és ez **soha** nem jelenik meg
  „nincs ilyen termék” eredményként.
- A `robots.txt` technikai protokoll, **nem** teljes jogi engedély. Élesítés
  előtt forrásonként dokumentálni kell a jogi státuszt; erre szolgál a
  `legal_review_status` és a `policy_disabled` kapcsoló.

---

## Licenc

Zárt, belső használatra. Minden jog fenntartva.
