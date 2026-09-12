# XLS-65 / XLS-66 — Rapport DevX (Track 2)

> **Version lisible pour le rendu :** [FEEDBACK_RENDU.md](./FEEDBACK_RENDU.md)  
> Ce fichier reste la fiche technique (Noé) : formules first-loss, preuves, portefeuille.

**Équipe :** SecondWave · **Focus :** Closed-Ended Vault + First-Loss  
**Statut :** monde Devnet généré le 2026-09-12T14:09:46Z (`npm run world`) · `network_id` 2 · `wss://s.devnet.rippletest.net:51233`  
**Explorer :** https://devnet.xrpl.org

### Catalogue on-chain (world.json)

| Clé | Signal analyste | `vault_id` | Broker / prêt |
|---|---|---|---|
| `sain` | défaillable non déclaré | [`501A62B4…20641`](https://devnet.xrpl.org/transactions/B1849EB1A7AEE566C026E73E71CA833DD3D120C5215E3DA5A74A52B290CCDCBF) | broker `062C562B106D0113651C8AB80657FBDE43C1F6491B31D9A4897F820B5C852391` · loans `276C3B87…` (défaillable), `621539E3…` |
| `predateur` | cover 0/0 + auto-prêt | [`64B3C650…2E94`](https://devnet.xrpl.org/transactions/99D3817A284737FA5DF19401A98D4A9A54F536AEB9E1E3ED9DCCE73AA6086341) | broker `92D86F2F2EE55A905B5B66030BC33A3EB4AF41960CD9B1D97ACC3C648BE12323` · loan `D249EAA34EBDECA654FE28D58DE4B5EF1F79EC4DB19E0D59035C7C825D9A4AB1` (borrower = owner) |
| `deprecie` | perte latente + impair | [`AECC188F…22FD`](https://devnet.xrpl.org/transactions/D7C6B7AF137AC6DBEA228BE60432CE1AEDAEE957769FD5970184F7D444AF0853) | broker `BBB9E744A63741BFDD257EE2C38E346B948984A28F225725B2226AD81B7257BD` · loans `80BE5049…` (impairé), `9D38AC4F…` |
| `iou` | clawback armé | [`E8C07618…ED5B`](https://devnet.xrpl.org/accounts/r8itRq6L6GkTrgG33sKA1kkhwJCcBjExr) | issuer `r8itRq6L6GkTrgG33sKA1kkhwJCcBjExr` · broker `1463504188DE6EF7B5B6D18993F561315BCB587EAF98501309754A69B80FC12C` · loan `89AB3399F244BDC09E28F3A19F87FA0982EBDF831A260D96DA7D70D1D1886B62` |
| `verrouille` | parts non transférables | `4CDED64F3AF15A9B0E0848D04885A2429C73FB7F5CDE04E436ECAA33C2E97385` | broker `CD078A0A83A6068F8314B191FE5761C515390F9B81F453CA6BA15F843A177C3D` |
| `redemption` | phase Redemption | `6A1EBB0AB83453F1A6946E8F5806FC2545CC4CDF492145F09792B35943E86F07` | aucun broker (sortie normale ouverte) |
| `solde` | cover 100 % retirable | `F8C3E8AC1959FDED72CDE280B17F85B7D1B5E75A4510852CB3A3B406D5EA752B` | broker `3CAFBC6DAAF2687848046630D8293B09FF240C12791ADB9DB0AC936E92549C07` · `DebtTotal = 0`, `CoverAvailable = 5000000` |

IDs complets (vault) :

```
sain        501A62B4E3D28FEEF032FC5DC64E583828D8CF7CA5EFAA0AA6310AEF21820641
predateur   64B3C650A8A561E1DDC83811061A8A46A58FD94EA531315839B22B19B06B2E94
deprecie    AECC188FD5656990E302355C67A3559EDA83F1C07937502404C5474F145322FD
iou         E8C07618C25A087EF9BDAB9CAEAD0C34DAE0F927AF53B157AB4435270EABED5B
verrouille  4CDED64F3AF15A9B0E0848D04885A2429C73FB7F5CDE04E436ECAA33C2E97385
redemption  6A1EBB0AB83453F1A6946E8F5806FC2545CC4CDF492145F09792B35943E86F07
solde       F8C3E8AC1959FDED72CDE280B17F85B7D1B5E75A4510852CB3A3B406D5EA752B
```

Lecture : `vault_info { vault_id }` puis `account_objects` du pseudo-compte. Relire : `npm run analyse -- live`.

---

## Verdict jury (30 secondes)

Le *first-loss capital* **n’est pas un coussin à hauteur de `CoverAvailable`**.  
Au défaut, le protocole ne liquide qu’une **fraction du *minimum requis*** :

```
DefaultCovered = min(
  DebtTotal × CoverRateMinimum × CoverRateLiquidation,
  DefaultAmount,
  CoverAvailable
)
```

Un broker peut afficher 5 000 de cover et n’en mobiliser que 500 (5 % de la dette). **95 % de la perte va aux déposants.** Le surplus de cover reste chez le broker.

C’est le comportement **spécifié et documenté** — pas un bug `rippled`. Le problème DevX : les **noms de champs** et la page concepts laissent croire l’inverse.

---

## P0 — First-loss : le cover déposé n’est pas le cover mobilisé

### Contexte

On construit l’analyste SecondWave (note AAA→D, implied APY, verdict liquidité vs détresse). Pour pricer une part de vault fermé pendant la phase Investment, il faut savoir **qui mange un défaut** : le broker (`CoverAvailable`) ou les déposants (`AssetsTotal` / NAV).

Transactions / objets : `LoanBrokerSet`, `LoanBrokerCoverDeposit`, `LoanManage` (`tfLoanDefault`).  
Sources : [XLS-66 §3.1.11](./xls-66_full_doc.md), [§3.10.5](./xls-66_full_doc.md), [xrpl.org — First-Loss Capital](https://xrpl.org/docs/concepts/tokens/lending-protocol#accounting), [LoanBrokerSet fields](https://xrpl.org/docs/references/protocol/transactions/types/loanbrokerset#fields).

### Issue

Deux lectures contradictoires du même protocole :

| Ce que le développeur (et le déposant) croit | Ce que `LoanManage` + `tfLoanDefault` fait |
|---|---|
| `CoverAvailable` est le capital en première ligne : un gros défaut le consomme d’abord | Seul `DebtTotal × CoverRateMinimum × CoverRateLiquidation` est éligible |
| `CoverRateLiquidation` = part de **la dette** (ou du cover déposé) liquidée | C’est une part du **cover *minimum*** uniquement |
| Plus le broker dépose, plus les LP sont protégés | Au-delà du cap protocolaire, chaque token de plus est **inutile au défaut** |

`CoverRateMinimum` et `CoverRateLiquidation` sont en **1/10 de basis point** (`10_000` = 10 %, `50_000` = 50 %). Un wallet qui affiche `5000` sans conversion ment d’un facteur 20.

### Impact

- Un intégrateur qui affiche `CoverAvailable / DebtTotal` comme « protection first-loss » **surestime** la protection d’un facteur `1 / CoverRateLiquidation` (×2 si liq = 50 %, ×10 si liq = 10 %).
- Un déposant de vault fermé **ne peut pas sortir** (`VaultWithdraw` → `tecTOO_SOON`) pendant que ce risque est mal affiché.
- C’est le cœur produit de SecondWave : une décote n’est une opportunité que si le first-loss **tient vraiment**. Sinon c’est de la détresse.

### Evidence

**1. Exemple officiel xrpl.org / XLS-66 §3.1.11** (recopié tel quel) :

| | |
|---|---|
| `DebtTotal` | 1 090 |
| `CoverRateMinimum` | 10 % |
| `CoverRateLiquidation` | 10 % |
| `CoverAvailable` | **1 000** |
| `DefaultAmount` | 1 090 |
| **`DefaultCovered`** | **10,9** (`1 090 × 0,10 × 0,10`) |
| **Perte vault / déposants** | **1 079,1 (99 %)** |
| Cover restant chez le broker | **989,1** |

Le tutoriel calcule correctement — et ne dit jamais en une phrase : *« 99 % de ce défaut n’est pas du first-loss »*.

**2. Reproduction SecondWave** (`npm test -w @secondwave/analyst`, `defaultCoverage`) :

```
DebtTotal            10 000
CoverAvailable        5 000     ← « on est largement couverts »
CoverRateMinimum     10 000     (10 %)
CoverRateLiquidation 50 000     (50 % du minimum)
DefaultAmount        10 000

protocolCap = 10 000 × 10 % × 50 % = 500
covered     = 500
vaultLoss   = 9 500   (95 % socialisé)
unusedCover = 4 500   (assis chez le broker)
```

Fichier : `packages/analyst/src/cover.mjs` + `packages/analyst/test/cover.test.mjs`.  
Rapport CLI : `npm run analyst` — ligne `proto cover cap = DebtTotal × min × liq (pas CoverAvailable entier)`.

**3. Formule on-chain** (XLS-66 §3.10.5, `LoanManage` / `tfLoanDefault`) :

```
DefaultAmount  = TotalValueOutstanding − ManagementFeeOutstanding
MinimumCover   = DebtTotal × CoverRateMinimum
DefaultCovered = min(MinimumCover × CoverRateLiquidation, DefaultAmount, CoverAvailable)
VaultLoss      = DefaultAmount − DefaultCovered
```

`CoverAvailable` n’est que le **troisième** `min`, un plafond, jamais la cible.

**4. Nommage xrpl.org (`LoanBrokerSet`)** :

> `CoverRateLiquidation` — *The 1/10th basis point of **minimum required** first-loss capital that is moved to an asset vault to cover a loan default.*

La phrase est exacte et **facile à rater**. Rien dans le tableau ne donne `max_payout_on_default = DebtTotal × min × liq`.

Objets Devnet (monde 2026-09-12T14:09:46Z) — le vault `predateur` est le cas 0/0 (aucun first-loss, donc cap = 0) :

| | |
|---|---|
| `vault_id` | `64B3C650A8A561E1DDC83811061A8A46A58FD94EA531315839B22B19B06B2E94` |
| LoanBroker | `92D86F2F2EE55A905B5B66030BC33A3EB4AF41960CD9B1D97ACC3C648BE12323` · `CoverRateMinimum=0` · `CoverRateLiquidation=0` · `CoverAvailable=0` · `DebtTotal=22000000` |
| Loan (auto-prêt) | `D249EAA34EBDECA654FE28D58DE4B5EF1F79EC4DB19E0D59035C7C825D9A4AB1` |
| Dernière tx vault | [`99D3817A…`](https://devnet.xrpl.org/transactions/99D3817A284737FA5DF19401A98D4A9A54F536AEB9E1E3ED9DCCE73AA6086341) |

Le vault `solde` montre P1.1 (cover encore là, dette nulle) : `vault_id` `F8C3E8AC1959FDED72CDE280B17F85B7D1B5E75A4510852CB3A3B406D5EA752B`, broker `3CAFBC6DAAF2687848046630D8293B09FF240C12791ADB9DB0AC936E92549C07`.

### Suggestion

1. **Docs (priorité jury / DevRel)**  
   Sur [First-Loss Capital](https://xrpl.org/docs/concepts/tokens/lending-protocol#accounting) et `LoanBrokerSet`, encadré unique :

   > **Protection réelle au défaut** = `DebtTotal × CoverRateMinimum × CoverRateLiquidation`.  
   > `CoverAvailable` est le solde en caisse, pas le montant versé aux LP.

   Ajouter une colonne « unused cover » dans l’exemple (1 000 − 10,9).

2. **Champ dérivé RPC**  
   `vault_info` / futur `loan_broker_info` : `FirstLossCap` / `MaxDefaultCover` déjà calculé. Aujourd’hui il n’existe **ni `loan_info` ni `loan_broker_info`**.

3. **Protocole (optionnel, V1.2)**  
   Flag ou politique `coverToAvailable` : liquider `min(DefaultAmount, CoverAvailable)` quand le broker le choisit. Aujourd’hui un broker « over-collateralisé » **ne peut pas** offrir plus de protection que `min × liq` sans changer les deux taux (et `CoverRateMinimum` bloque l’émission de prêts s’il est trop haut).

4. **Wallets / SDK**  
   Helper `firstLossCap(broker)` dans xrpl.js — 5 lignes, zéro ambiguïté d’unités (1/10 bps).

SecondWave expose déjà `protocolCap`, `unusedCover`, `depositorShare` dans l’analyste.

---

## P1 — Corollaires (même famille de risque)

### P1.1 — `DebtTotal = 0` : le broker rapatrie 100 % du cover

`LoanBrokerCoverWithdraw` n’impose le plancher `DebtTotal × CoverRateMinimum` que s’il reste de la dette. Après remboursement / défaut qui remet `DebtTotal` à 0, le first-loss n’est plus verrouillé.  
Un déposant qui voit encore `CoverAvailable` élevé **juste après** un cycle de prêts peut croire à une réserve permanente. Elle est retirable.

### P1.2 — La NAV ment jusqu’à `LoanManage`

`AssetsTotal` / `LossUnrealized` ne bougent qu’à l’**impair** ou au **défaut**, pas au retard. Un prêt `NextPaymentDueDate + GracePeriod` dépassé, flags à 0, laisse la NAV intacte. Sur un vault fermé (`tecTOO_SOON`), le déposant est captif d’un prix qui n’a pas encore bougé.  
L’analyste SecondWave marque ce cas en **décote de détresse latente**.

### P1.3 — Pas d’API de lecture métier

Pas de `loan_info`, `loan_broker_info`, `mpt_holders`. Traversée imposée : `vault_info` → `account_objects` du pseudo-vault → `account_objects` de chaque pseudo-broker. Un `Loan` disparaît au `LoanDelete` : **pas d’historique on-chain** pour le NPL. Tout score de crédit exige un indexeur hors-chaîne.

### P1.4 — L’extension wallet Ripple sérialise `VaultDeposit.Amount` comme un IOU

L’UI officielle construit toujours :

```json
"Amount": { "currency": "XRP", "value": "10000000" }
```

Sur un vault XRP le ledger exige une **string de drops** (`"10000000"`). Le wallet répond `invalid field Amount` sans dire que le type JSON est faux, et **l’utilisateur ne peut pas éditer le JSON**. Impasse : on ne peut pas souscrire à un vault XLS-65 XRP depuis l’extension.

- Compte : `rhZH7Nb76CRNQ6wMMCZr48ZVdnA1zNH5zw`
- Vault : `AE297588323475AB4FA98C35E9BA07044029A3E51175125F6FC801712541B8D4` (Devnet, Asset XRP)
- Capture DevEx : `sdk` / `error_message` / `VaultDeposit`

**Fix attendu :** si `vault.Asset.currency === "XRP"`, envoyer `Amount` en string ; garder l’objet `{currency, issuer, value}` uniquement pour un IOU.

---

## File d’attente (à documenter avec hashes Devnet)

| # | Surface | Sujet |
|---|---|---|
| Q1 | sdk | `xrpl.js` 5.2.0 : codec V1.1 OK, types `VaultCreate` sans `VaultKind` / `SubscriptionDate` / `RedemptionDate` |
| Q2 | protocol | `LoanSet` : échéancier trop long → `tecNO_PERMISSION` (rien sur les dates) |
| Q3 | protocol | `VaultWithdraw` en Investment → `tecTOO_SOON` ; `VaultDeposit` hors Subscription → `tecEXPIRED` |
| Q4 | infra | `MPTokensV2` absent : pas d’`OfferCreate` sur les parts — règlement = `Batch` |
| Q5 | sdk | `LoanSet` co-sign : préfixe `CPT\0` vs `STX\0` (fixCleanup3_4_0) — voir README |

Template pour chaque fiche suivante : **Contexte / Issue / Impact / Evidence (hash) / Suggestion**.

---

## Réponses brief (Track 2)

| Question | Réponse courte |
|---|---|
| Vault ↔ Broker ↔ Loan intuitif ? | Non : Owner du vault **doit** être le broker ; le cover n’est pas ce que son nom suggère. |
| `CoverRateMinimum` / `CoverRateLiquidation` se comportent comme leur nom ? | **Non** — voir P0. Liquidation ≠ % du cover affiché. |
| Co-signature `LoanSet` | File Q5 (SDK). |
| SDK vs JSON brut | V1.1 closed vault : champs absents des types TS (Q1). |
| Lire position / rendement on-chain ? | NAV + first-loss **à reconstruire** ; pas de RPC métier (P1.3). |
| Docs vs réalité | L’exemple officiel *calcule* 10,9 / 1 090 mais ne le *nomme* pas comme limite produit. |
