# Döntési politika — hogyan dönt a párosító?

> Ez a dokumentum azt írja le, **mit garantál** és **mit nem** a párosító motor.
> A megvalósítás a `packages/domain/src/matching/` alatt található, és a
> `tests/unit/matching.test.ts` bizonyítja.

---

## Az alapelv

```
Többcsatornás jelöltkeresés
  + strukturált attribútumkinyerés
  + kizáró ellentmondások
  + bizonyítékalapú pontozás
  + bizonytalanság esetén tartózkodás vagy emberi döntés
```

A rendszer **nem** egyetlen hasonlósági számot számol. Először **kizárja** a
bizonyítottan hibás párokat, és csak a megmaradtakat értékeli.

**„Biztosan működő” rendszer kizárólag úgy készíthető, ha a rendszernek
engedélyezett a `nem bizonyítható` válasz.**

---

## Három állapot, sosem kettő

Minden mező-összehasonlítás három értéket vehet fel:

| Állapot | Jelentés |
| --- | --- |
| `match` | mindkét oldalon **ismert** és egyezik |
| `contradiction` | mindkét oldalon **ismert** és eltér |
| `unknown` | legalább az egyik oldalon nincs kellően bizonyított érték |

Az `unknown` **nem egyezés**, de nem is automatikus ellentmondás.
**Soha nem alakítható `match`-csé.**

Kötelező mező `unknown` állapota alapértelmezésben megakadályozza az
automatikus új párosítást.

---

## Kizáró ellentmondások (hard gate)

Ezeket a pontszám **nem írhatja felül**. Ha bármelyik fennáll, a jelölt kiesik:

- bizonyított termelő / márka eltérés
- inkompatibilis kategória
- pontos expression / tétel eltérés
- eltérő évjárat, ha a termék vintage-érzékeny
- vintage és non-vintage ellentmondás
- eltérő korjelölés vagy edition
- eltérő kiszerelés (max **5 ml** formázási tolerancián túl)
- eltérő darabszám
- eltérő csomagolás, ha a policy nem enged egyenértékűséget
- eltérő puttonyszám
- eltérő alkoholtartalom, ha az adott tételnél változatot különböztet meg
- explicit negatív alias vagy korábbi kézi elutasítás
- mindkét oldalon ismert, egymástól **eltérő** GTIN

### Amit ez a gyakorlatban jelent

| Pár | Eredmény |
| --- | --- |
| Black Label ↔ Double Black | elutasítva |
| Glenfiddich 12 ↔ Glenfiddich 8 | elutasítva |
| Aszú 5 puttonyos ↔ 6 puttonyos | elutasítva |
| 0,7 l ↔ 1 l | elutasítva |
| 0,75 l ↔ 1,5 l magnum | elutasítva |
| sima palack ↔ díszdoboz | elutasítva *(kivéve explicit, auditált policy)* |
| 1 × 0,75 l ↔ 6 × 0,75 l karton | elutasítva |
| NV pezsgő ↔ vintage pezsgő | elutasítva |
| Gin ↔ Sloe Gin | elutasítva (negatív alias) |

---

## Pontozás

| Mutató | Mit mér |
| --- | --- |
| `agreement_score` | az **ismert**, összehasonlítható mezők súlyozott egyezése |
| `evidence_coverage` | a **szükséges** bizonyítékok lefedettsége |
| `extraction_quality` | a **gyengébbik** oldal forráskinyerésének megbízhatósága |
| `retrieval_support` | hány és milyen erős csatorna találta meg |
| `top_margin` | különbség az első és a második jelölt között |
| `contradiction_count` | automatikus elfogadáshoz kötelezően **0** |
| `negative_history` | korábbi elutasítások száma |

### Az `evidence_coverage` finomsága

A `required` mezőknél **minden hiány számít**. Az opcionális mezőknél viszont
csak akkor van mit bizonyítani, ha **legalább az egyik oldal** ismeri az
értéket. Ha egyik forrás sem említi (például a bornak nincs feltüntetett
hordóérlelése), az nem hiányzó bizonyíték, hanem nem létező attribútum — ezért
kiesik a nevezőből.

---

## Automatikus párosítás feltételei

Automatikus elfogadás **csak akkor** engedélyezett, ha **mind** teljesül:

- nincs hard contradiction
- **minden** `required` attribútum bizonyítottan egyezik
- `evidence_coverage ≥ 0,90`
- `extraction_quality ≥ 0,90`
- `agreement_score ≥ 0,96`
- `top_margin ≥ 0,10`
- a márka/expression egyezés **nem pusztán fuzzy**
- nincs korábbi elutasítás ugyanerre a párra
- az `auto_match` feature flag aktív

**A pilotban az `auto_match` alapértelmezetten kikapcsolt.** Ha bekapcsolják, az
`auto_match_identifier_only` mellett csak exact platformazonosító vagy GTIN
alapján fogadható el pár.

---

## Kategóriafüggő identitás

Nincs egyetlen, minden termékre érvényes merev szabály. A kategória
`identity_profile`-ja mondja meg, mely mező `required`, `contradiction_only`,
`supporting` vagy `not_applicable`.

| Kategória | Kötelező mezők |
| --- | --- |
| Bor | termelő, tétel, **évjárat**, kiszerelés, darabszám, csomagolás |
| Pezsgő / champagne | termelő, cuvée, **dosage**, vintage státusz, kiszerelés, darabszám, csomagolás |
| Tokaji aszú | termelő, tétel, évjárat, **puttonyszám**, kiszerelés, darabszám, csomagolás |
| Töményital | márka, expression, kiszerelés, darabszám, csomagolás (+ korjelölés/edition, ha van) |
| Pálinka | termelő, **gyümölcs + tétel**, kiszerelés, darabszám, csomagolás |

### Bor és az EAN

**Az EAN egyes boroknál több évjáraton keresztül változatlan marad.** Ezért
vintage bornál az EAN-egyezés **nem** oldja fel a hiányzó vagy eltérő
évjáratot. A rendszer ilyenkor `EAN_MATCH_VINTAGE_UNPROVEN` indokkal
felülvizsgálatot kér.

---

## A „nincs találat” bizonyítása

A `not_found_after_full_search` **csak akkor** adható, ha:

- a webshop health checkje sikeres
- a katalógus discovery nem mutat szerkezeti regressziót
- minden konfigurált keresési út lefutott
- a keresési terv és eredménye naplózott
- nincs feldolgozatlan parse hiba
- nincs olyan gyenge jelölt, amely review-t igényelne

Ellenkező esetben a státusz `search_incomplete`, `source_unavailable`,
`parse_error` vagy `needs_review`.

**Egyetlen keresési hiba sem eredményezhet „nincs ilyen termék” állapotot.**

---

## Az AI szerepe

**Engedélyezett:** mezők kinyerése bizonyítékkal, ritka elnevezési változatok
jelöltként felvetése, review-sorrend támogatása, emberi olvasásra szánt
magyarázat, alias-javaslat.

**Nem engedélyezett:** bizonyíték nélküli attribútumkitalálás, hard
contradiction felülírása, végső pár automatikus jóváhagyása kizárólag
LLM-válasz alapján, küszöb vagy aliaslista önálló online módosítása, a
forrásoldal helyett a modell általános tudásának használata.

Minden AI által kinyert mezőhöz **eredeti szövegrészletet és forráshelyet** kell
adni. Bizonyíték hiányában az érték `unknown`.

---

## Kalibráció

Küszöbértéket **nem szabad érzés alapján** véglegesíteni. A rendszer a review
döntésekből címkézett adathalmazt épít, és offline kiértékeléssel mutatja a
precisiont, recallt, false positive rate-et, kategóriánkénti és
webshoponkénti eredményt, valamint a küszöbgörbét.

**Online, felügyelet nélküli önmódosítás tilos.** Új küszöb csak verziózott
release-ként, regressziós teszttel kerülhet élesbe — az API ezt technikailag is
kikényszeríti: kritikus beállítás módosításához admin jogosultság **és** friss,
sikeres golden kiértékelés azonosítója kell.

### Elfogadási célok (pilot vége előtt)

- `candidate_recall@10 ≥ 98%` a golden positive halmazon
- automatikusan elfogadott párok precisionje **≥ 99,5%**
- minden ismert hard negative 100%-ban elutasítva vagy review-ba küldve
- hard contradictiont tartalmazó párból **0** auto-match
- `unknown required field` esetből **0** auto-match
- a precision **95%-os konfidenciaintervallumát** is jelenteni kell
- a kézi review medián ideje 30–60 másodperc/eset
- false positive üzleti tolerancia: **0**

> A 99,5%-os cél nem abszolút matematikai garancia. A tényleges üzleti védelem
> a magas precision, a hard gate, a tartózkodás és az emberi review
> **együttese**.
