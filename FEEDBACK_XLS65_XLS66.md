# XLS-65 / XLS-66 — Rapport DevX (Track 2)

**Équipe :** SecondWave · **Focus :** Closed-Ended Vault + First-Loss  
**Statut :** fiche majeure rédigée hors dump Devnet ; hashes de tx à coller dès que `fixtures/` sort.

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

Hash Devnet : *à coller après `npm run world`* — `LoanBrokerCoverDeposit` 5 000 + `LoanManage`/`tfLoanDefault` + lecture `CoverAvailable` avant/après.

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
