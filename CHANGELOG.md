# Változásnapló

A verziószám egyetlen forrása a gyökér `package.json` (a workspace-ek ugyanazt
viselik). A futó példány verziója és build-azonosítója (a forrás tartalmi
hash-e, `scripts/build-info.mjs`) itt látszik:

- a felület bal alsó sarkában (`v2.2.0 · a1b2c3d4`),
- az API `/api/v1/health` válaszában (`version`, `build`),
- az api, a worker és a scheduler induló logsorában.

## 2.2.0 – 2026-09-25

### Javítva

- **A döntési napló nem nő tovább ismétlésekből.** A klaszterezési söprés
  percenként ugyanazt a ~300 párosítatlan listinget értékelte újra, és
  mindegyik új döntési sort írt: napi ~420 ezer sort, 22 nap alatt 38 GB-ot
  (a sorok 99,9%-a pontos ismétlés volt). Mögötte 10 447 listing sosem került
  sorra.
  - Ha egy listing a kiértékelés után is párosítatlan marad, a söprés egy
    ideig nem veszi elő (`source_listings.cluster_retry_at`, döntésnél 7 nap,
    akadálynál 1 nap). Ha közben a listing adata változik, a felderítés külön
    jobot indít rá, az nem vár.
  - Ha a motor ugyanarra a (változat, bolt, listing) hármasra pontosan
    ugyanazt dönti, nem keletkezik új sor: a meglévő `seen_count`-ja nő, a
    `last_seen_at` pedig jelzi az utolsó megerősítést.
- **Egy listing kiértékelése nem írja felül egy másik listinggel már igazolt
  pár állapotát.** A hurok az igazolt párokat percenként
  „ellenőrzés szükséges” állapotba írta, `matched_listing_id` nélkül. A `0024`
  migráció a sérült párokat helyreállítja.
- A Beállítások oldal „Több egyforma jelölt” és „Nem bizonyítható” száma a
  párok mostani állapotát mutatja, nem a döntési napló sorait (előtte 3,2
  milliót mutatott kb. 140 párra).

### Új

- `cluster_sweep_backlog` nézet: a klaszterezési hátralék egyetlen
  definíciója. Ezt használja a söprés, az ütemező, a Folyamatkezelés és a
  `pipeline-check`. A `pipeline-check` az újrapróbálásra váró listingeket is
  kiírja.
- A napi takarítás a döntési naplóra is kiterjed: a 180 napnál régebbi,
  felülírt és sehonnan nem hivatkozott gépi döntések törlődnek
  (`retention.decisionDays`). Emberi döntés, hármasonként a legutolsó döntés
  és a hivatkozott döntések soha nem törlődnek.
- Verzió és build-azonosító a felületen, az API health válaszában és a
  logokban.

### Üzemeltetés

- Ez a verzió a meglévő ismétlődő döntési sorokat **nem** törli. A lemezhely
  visszaadása külön, egyszeri karbantartás.

## 2.1.0 és korábbi

A korábbi változások a git-történetben olvashatók.
