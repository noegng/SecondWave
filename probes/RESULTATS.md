# Batterie de tests XLS-65 / XLS-66 — Devnet public — résultats

- **Réseau** : Devnet public (`wss://s.devnet.rippletest.net:51233`), rippled 3.4.0-rc5, `LendingProtocolV1_1` actif, base fee **1 drop**, owner reserve **0,2 XRP**, réserve de base **1 XRP**.
- **Lib** : `xrpl.js@5.2.0-beta.0` + `ripple-binary-codec@2.11.0` (campagnes A→Y) ; l'annexe Z et la revalidation SDK datent du passage à **`5.2.0-beta.1`** (12/09, voir l'encart de FRICTIONS.md).
- **Scripts** : `probes/campaign-{a,b,b2,c,d,e,f2,f3,g2,h,i,j,x}.mjs` — chaque campagne écrit `probes/out/<c>.json` (codes + messages exacts + hashes).
- **Convention** : *SDK* = rejet levé par la validation client de xrpl.js (la tx ne part jamais) ; *local check* = rejet du nœud avant l'engine (`invalidTransaction`) ; sinon code moteur (`tem`/`tec`/`tes`).

Légende verdicts : ✅ conforme à l'attendu · ⚠️ surprenant · 📖 non documenté · 🐛 bug probable.

---

## Campagne A — `VaultCreate`, la matrice de validation

| # | Cas | Résultat | Verdict |
|---|---|---|---|
| 1 | Open-ended (`VaultKind` absent) | `tesSUCCESS`. L'objet porte `LEVersion: 1`, pas de `VaultKind`. | ✅ |
| 15 | **Fee réel** | autofill fixe `Fee = 200000 drops` (0,2 XRP = une owner reserve, **brûlée**) alors que la base fee est 1 drop. `OwnerCount` du créateur **+3** par vault (vault + issuance + pseudo-compte). | 📖 |
| 2/3 | `VaultKind:1` sans l'une des dates | **Bloqué côté SDK** : « A close-ended vault requires both SubscriptionDate and RedemptionDate ». Côté serveur brut : voir X6. | ✅ |
| 4 | `SubscriptionDate` dans le passé | `tecEXPIRED` — un vault ne peut pas naître directement en Investment. Idem avec les deux dates passées. | 📖 |
| 5/6 | Écart red−sub | **Plancher exactement 180 s** (179 refusé, 180 accepté). Message SDK : « must be within **[180, 946708560)** seconds ». | ✅ |
| 7 | Écart très long | 30 ans accepté, 31 ans refusé — plafond ≈ 946 708 560 s (~30,02 ans). | 📖 |
| 8/9 | `Scale` sur XRP / MPT | Bloqué SDK : « Scale parameter must not be provided for XRP or MPT assets ». Serveur brut : `temMALFORMED` (X6). | ✅ |
| 10 | `Scale` sur IOU | **[0, 18]** inclus. 19 et 255 : « Scale must be a number between 0 and 18 inclusive ». | 📖 |
| 11 | `AssetsMaximum` fini | Dépôt de pile le max : `tesSUCCESS`. 1 drop de plus : `tecLIMIT_EXCEEDED`. | ✅ |
| 12 | `WithdrawalPolicy` | **Seule la valeur 1 existe** (first-come-first-served). 0, 2, 99 → `temMALFORMED` (serveur). | 📖 |
| 13 | `Data` | 1 à 256 octets OK ; 257 → « Data exceeds 256 bytes » ; vide (`''`) refusé par le SDK. | ✅ |
| 14 | `MPTokenMetadata` | Recopié tel quel sur l'issuance des parts. Le SDK émet un lint XLS-89 (non bloquant). | ✅ |
| 16 | `tfVaultPrivate` **sans** `DomainID` | `tesSUCCESS`, `shares.Flags=60`. Gate = **propriétaire seul** : tiers → `tecNO_AUTH`, owner → `tesSUCCESS`. C'est un « coffre personnel ». | ⚠️📖 |
| 17 | `DomainID` sans le flag privé | Bloqué SDK : « Cannot set DomainID unless tfVaultPrivate flag is set ». Serveur brut : `temMALFORMED` (X6). | ✅ |
| 18 | `DomainID` inexistant | `tecOBJECT_NOT_FOUND`. | ✅ |
| 19 | `tfVaultShareNonTransferable` | `tesSUCCESS`, **`shares.Flags=0`** (aucun CanTransfer/CanTrade/CanEscrow). | ✅ |
| 20 | Empilement | **40 vaults** créés par le même compte sans jamais être refusé (limite = fonds : 0,2 XRP brûlé + 0,6 XRP de réserve par vault ; OwnerCount 1→121). | ✅ |

**Grille des flags d'issuance de parts** (A + D) :

| Vault | `shares.Flags` | Décomposition |
|---|---|---|
| public, transférable | **56** | CanEscrow(8)+CanTrade(16)+CanTransfer(32) |
| privé, transférable | **60** | 56 + RequireAuth(4) |
| public, non transférable | **0** | rien |
| privé, non transférable | **4** | RequireAuth seul |

---

## Campagne B — les phases

### La matrice 7 transactions × 3 phases (cas 21) — codes exacts

| Transaction | Subscription | Investment | Redemption |
|---|---|---|---|
| `VaultDeposit` | ✅ `tesSUCCESS` | ❌ `tecEXPIRED` | ❌ `tecEXPIRED` |
| `VaultWithdraw` | ✅ `tesSUCCESS` | ❌ `tecTOO_SOON` | ✅ `tesSUCCESS` |
| `VaultSet` (Data) | ✅ | ✅ | ✅ |
| `VaultDelete` (vault vide) | ✅ | ✅ | ✅ |
| `LoanBrokerSet` (création) | ✅ **même en Subscription** | ✅ | ✅ **même en Redemption** |
| `LoanSet` (valide) | ❌ `tecTOO_SOON` | ✅ `tesSUCCESS` | ❌ `tecEXPIRED` |
| `LoanPay` | *(structurel : aucun prêt ne peut exister)* | ✅ | ✅ (X8 : `tesSUCCESS`) |
| `LoanManage` (impair/défaut) | *(structurel)* | ✅ | ✅ (X8) |

Lecture des codes (cas 24) : **`tecEXPIRED` = « la fenêtre est passée », `tecTOO_SOON` = « la fenêtre n'est pas ouverte »** — cohérent mais indiscernable d'un credential expiré (D-41b) ou d'un dépôt hors AssetsMaximum sans lire les dates du vault.

- ⚠️ **Un broker peut être créé dans n'importe quelle phase**, y compris en Redemption (il ne pourra juste jamais prêter). `VaultDelete` d'un vault vide passe dans toutes les phases.
- 22/23 (bascule à la seconde) : campagne B2, voir plus bas.

### 25 — open-ended
Dépôt, retrait, `VaultSet` : libres à tout moment. `LoanBrokerSet` : **`tecNO_PERMISSION`** — sous V1_1 le prêt est réservé aux closed-ended. Conséquence structurelle : **le ratio parts/actif ne peut jamais bouger dans un vault où les dépôts sont ouverts** (l'intérêt exige un prêt ⇒ closed-ended ⇒ dépôts fermés en Investment). Le prix d'entrée est donc toujours 1:1 (cas C-29 résolu structurellement).

### 26 — déplacer les dates après coup : IMPOSSIBLE
`SubscriptionDate` et `RedemptionDate` **ne sont pas des champs de `VaultSet`** : le nœud rejette aux local checks « **Field 'SubscriptionDate' found in disallowed location.** » — dans les trois phases, dans les deux sens, et pareil sur un open-ended. **Aucun enfermement possible par report de la Redemption.** (Le message, en revanche, est cryptique — voir FRICTIONS.)

### 27 — `VaultDelete`
- Avec parts en circulation : `tecHAS_OBLIGATIONS`.
- Sans parts mais avec broker(s) attaché(s) : `tecHAS_OBLIGATIONS`.
- Après `LoanBrokerDelete` du premier broker : **encore** `tecHAS_OBLIGATIONS` — les deux autres brokers créés par la matrice traînaient encore. Il faut détruire **tous** les brokers d'abord.
- `LoanBrokerDelete` sans prêt : `tesSUCCESS` ; avec prêt en cours : `tecHAS_OBLIGATIONS` (E-62).

---

## Campagne B2 — la bascule de phase à la seconde près (22-23)

5 comptes tirent la même transaction à frontière−2 s, −1, 0, +1, +2 (soumission brute, sans attente), puis on lit le code final, le ledger d'inclusion et sa `close_time`.

| Frontière | −2 s | −1 s | 0 | +1 s | +2 s |
|---|---|---|---|---|---|
| `SubscriptionDate` : dépôt (permis→interdit) | ✅ | ✅ | ✅ | ✅ | ✅ *(ledger close = frontière **+8 s**)* |
| `RedemptionDate` : retrait (interdit→permis) | ❌ `tecTOO_SOON` | ❌ | ❌ | ❌ | ❌ *(ledger close = frontière **+8 s**)* |

**Lecture** : la bascule ne se fait ni à la seconde ni même à la close time du ledger d'inclusion — le check utilise la **close time du ledger parent** (en retard d'un ledger, ~4 s) avec une `close_time_resolution` de **10 s**. Résultat : une zone floue de **~5 à 12 s après la frontière où l'ancienne phase s'applique encore**, dans les deux sens (le dépôt passe encore, le retrait ne passe pas encore). Déterministe on-chain, mais toute UI qui affiche la phase à l'horloge murale contredira le ledger pendant ~10 s. À budgéter dans toute démo chronométrée.

---

## Campagne C — parts, comptabilité, arrondis

| # | Cas | Résultat | Verdict |
|---|---|---|---|
| 28 | Premier dépôt 5 XRP | 5 000 000 parts — ratio **exactement 1:1** (1 part = 1 drop). | ✅ |
| 29 | Dépôt après intérêt | **Structurellement impossible** (voir B-25) : les dépôts sont fermés dès que le vault peut percevoir un intérêt. | 📖 |
| 30 | Dépôt de 1 drop | `tesSUCCESS`, +1 part. Dépôt de 0 : `temBAD_AMOUNT`. Dépassement du max : `tecLIMIT_EXCEEDED` (A-11). | ✅ |
| 31 | Retrait total | L'objet `MPToken` **reste sur le compte à solde 0** (il n'est pas auto-supprimé ; il compte dans la réserve du détenteur). | ⚠️ |
| 32 | Retirer plus que son solde | `tecINSUFFICIENT_FUNDS`. | ✅ |
| 33 | Retrait > `AssetsAvailable` | Voir G-91 : `tecINSUFFICIENT_FUNDS`, retrait partiel calé sur AssetsAvailable OK. | ✅ |
| 34a | 100 dépôts + 100 retraits de 333 337 drops (rafale, séquences explicites) | Retour exact à 0 partout. **Aucune fuite** sur XRP. | ✅ |
| 34b | 30 aller-retours de `0.7777777` USD sur IOU **Scale 6** | Solde trustline revenu **exactement** au point de départ (100 000 USD) après avoir tout retiré. Aucune fuite. Un montant à 15 décimales est tronqué à l'échelle : `3.333333333333333` → 3 333 333 parts, `AssetsTotal=3.333333`. | ✅ |
| 34c | IOU **Scale 18** : saturation | 9 USD → 9×10¹⁸ parts (`tesSUCCESS`, sous 2⁶³−1). 1 USD de plus → **`tecPATH_DRY`** : le dépôt qui ferait déborder l'offre de parts échoue avec un code de *pathfinding*. | 🐛 code trompeur |
| 34d | 15 aller-retours Scale 18 à 16 décimales | Trustline strictement inchangée. Aucune fuite non plus à l'échelle maximale. | ✅ |
| 35 | `holderMap` vs `OutstandingAmount` | Réconciliation exacte après dépôts + transfert + retraits. | ✅ |
| 36 | Transfert de parts entre tiers | `vault_info` strictement identique avant/après (AssetsTotal, AssetsAvailable, OutstandingAmount). | ✅ |
| 37 | `tfMPTUnauthorize` avec solde non nul | `tecHAS_OBLIGATIONS`. | ✅ |
| 38 | Détenteur qui ferme son MPToken | `holderMap` réconcilie toujours (DeletedNode ⇒ solde 0 dans le rejeu). ⚠️ Asymétrie observée : après retrait total, l'objet MPToken de W (auto-créé par le dépôt) **reste** à 0, celui de m3 (créé par `MPTokenAuthorize` explicite puis vidé par retrait) **disparaît**. | ⚠️ |

---

## Campagne D — vault privé, domaine, credentials

| # | Cas | Résultat | Verdict |
|---|---|---|---|
| 39 | Dépôt sans credential | `tecNO_AUTH`. | ✅ |
| 40 | Credential émis **non accepté** | `tecNO_AUTH` — indistinguable de « aucun credential ». | ✅ |
| 41 | Credential **expiré** | Dépôt → **`tecEXPIRED`** (code distinct !). Retrait → `tesSUCCESS`. Pas d'enfermement. | 📖 |
| 42 | Credential **révoqué** (`CredentialDelete`) avec parts en main | Dépôt → `tecNO_AUTH`. **Retrait → `tesSUCCESS`** : le membre exclu peut toujours sortir. | ✅ rassurant |
| 43 | `DomainID` sur l'issuance | **Recopié sur l'issuance des parts** (le gate de transfert est porté par le MPT lui-même). | ✅ |
| 44 | `AcceptedCredentials` modifié après création | **Effet immédiat** : le déposant dont le type de credential est éjecté perd le dépôt (`tecNO_AUTH`) à la transaction suivante. Retrait toujours permis. | ⚠️ |
| 45 | Domaine à plusieurs credentials | Un seul suffit. | ✅ |
| 46 | Nombre max d'`AcceptedCredentials` | **10** (11 → rejet SDK « cannot exceed 10 elements »). | ✅ |
| 47 | Domaine pointant un « émetteur » qui n'a jamais rien émis | `tesSUCCESS` — aucune validation d'existence. | 📖 |
| 48 | Le propriétaire doit-il être membre ? | **Non** : création OK sans credential, et **le propriétaire dépose dans son propre vault privé sans être membre du domaine** (exemption owner). | ⚠️📖 |
| 49 | Flags d'issuance | Voir grille en campagne A. | ✅ |

---

## Campagne E — `LoanBroker` et first-loss capital

| # | Cas | Résultat | Verdict |
|---|---|---|---|
| 50 | `LoanBrokerSet` sur open-ended | `tecNO_PERMISSION` (B-25). | ✅ |
| 51/52 | Un seul CoverRate non nul | Bloqué SDK : « CoverRateMinimum and CoverRateLiquidation must both be zero or both be non-zero ». Serveur brut : voir X6. | ✅ |
| 53 | Les deux à zéro | Accepté. Conséquence mesurée en G-86 : **les déposants absorbent 100 % du défaut**. | ✅ |
| 54 | Modifier les rates après création | Voir X1 (retesté proprement — la 1re tentative a montré que le SDK **exige `VaultID` même pour un update**). | |
| 55 | **Unité des CoverRate** | **1/100 000** : broker `CoverRateMinimum=100000` (=100 %) avec 1 XRP de cover → prêt de 10 XRP refusé (`tecINSUFFICIENT_FUNDS`), prêt de 0,1 XRP accepté. | 📖 |
| 56 | Cover au-delà du minimum | Aucun plafond rencontré (20 XRP sur dette nulle : OK). | ✅ |
| 57 | Retrait de 100 % du cover à `DebtTotal=0` | `tesSUCCESS` confirmé (y compris sur un broker orphelin d'un run précédent). **Course contre un `LoanSet` co-signé** : le retrait passe, le `LoanSet` perdant échoue en `tecINSUFFICIENT_FUNDS` — pas de prêt créé sans cover. Sûr, mais griefable (voir SECURITY-NOTES). | ✅ |
| 58 | Plancher du cover avec dette | Retrait total → `tecINSUFFICIENT_FUNDS` ; le plancher est `DebtTotal × CoverRateMinimum / 100000` — vérifié au drop près en X7. | ✅ |
| 59 | `ManagementFeeRate` | Borne SDK : **[0, 10000]** (10 % max, unité 1/100 000). Qui encaisse : voir X3 (flux). | 📖 |
| 60 | Deux brokers, une liquidité | **Pool partagé** : broker A prête 35/50, broker B demande 30 → `tecINSUFFICIENT_FUNDS`. | ✅ |
| 61 | `DebtMaximum` atteint | `tecLIMIT_EXCEEDED` (F-68). | ✅ |
| 62 | Supprimer un broker endetté | `tecHAS_OBLIGATIONS`. | ✅ |

---

## Campagne F — `LoanSet` et cycle de vie

### 🐛 La contrainte non documentée qui a coûté une matinée
**`60 ≤ GracePeriod ≤ PaymentInterval` (donc `PaymentInterval ≥ 60`)** — toute violation sort en **`temINVALID` « The transaction is ill-formed »**, sans aucune indication du champ fautif. Balayage exact : grace 59 ❌ / 60 ✅ / = interval ✅ / interval+1 ❌. C'est cette règle qui faisait échouer nos trois premiers `LoanSet` (grace 30). Aucune spec publiée ne la mentionne.

| # | Cas | Résultat | Verdict |
|---|---|---|---|
| 63 | **Bug de co-signature du SDK** | `signLoanSetByCounterparty` (préfixe `STX\0`) → le nœud refuse aux local checks : **« fails local checks: Counterparty: Invalid signature. »**, remonté par xrpl.js comme **exception WebSocket** (pas un code). Le fix `CPT\0` (`core.counterpartySign`) → `tesSUCCESS`, mêmes termes. Confirmé. | 🐛 |
| 64 | Multisig `CPM\0` | Helper SDK multisig → « Counterparty: Invalid signature on account … » (**même bug de préfixe en multisig**). Notre premier essai manuel → « Counterparty: **Unsorted Signers array** » (tri lexicographique ≠ tri par ID binaire). Retesté trié en X5. | 🐛 |
| 65 | Sans `CounterpartySignature` | `temBAD_SIGNER`. | ✅ |
| 66 | Co-signé par le mauvais compte | `tefBAD_AUTH`. | ✅ |
| 67 | Principal > AssetsAvailable | `tecINSUFFICIENT_FUNDS`. | ✅ |
| 68 | Principal > DebtMaximum | `tecLIMIT_EXCEEDED`. | ✅ |
| 69 | **Marge de fin vs RedemptionDate** | Fin à red−0/30/59/60/61 s → **`tecNO_PERMISSION`** (pas `tecEXPIRED` !) ; red−120 s → `tesSUCCESS`. `GracePeriod` **ne compte pas** (fin à red−90 avec grace 120 → OK). Affinage en X2. | ⚠️📖 |
| 70 | `PaymentTotal` 0 | `temINVALID`. `PaymentTotal` 4294967295 × interval 60 → **`tecKILLED` « No funds transferred and no offer created. »** — un overflow d'échéancier sort avec un message d'**offre DEX**. | 🐛 message |
| 71 | Bornes interval/grace | Voir la règle ci-dessus. | 📖 |
| 72 | **Unité d'`InterestRate`** | **Annualisé, en 1/100 000** : 10 XRP à rate 100000 (=100 %/an) → intérêt 64 drops pour 200 s, 127 drops pour 400 s (10M × 200/31 536 000 = 63,4 ✓). Rate 0 : TVO = principal. Rate 4294967295 : `temINVALID`. ⚠️ *Ce n'est PAS la même échelle d'usage que les CoverRate : mêmes 1/100 000 mais l'un est annualisé, l'autre est un ratio instantané.* | 📖 |
| 73 | Frais : qui encaisse ? | `LoanOriginationFee` (0,1 XRP) part **directement au compte du broker owner** au moment du `LoanSet` (le vault paie 10 XRP, l'emprunteur reçoit 9,9). Service/late/management : voir X3. | 📖 |
| 74 | `StartDate` | Local check : « **Field 'StartDate' found in disallowed location.** » — et l'exception fait crasher `submitAndWait`. | ✅ (confirmé) |
| 75 | `Data` sur LoanSet | `tesSUCCESS`… et le champ est **absent de l'objet Loan**. Validé puis jeté, confirmé. | 🐛 |
| 76 | Où va l'argent au `LoanSet` | pseudo-vault −10 XRP → emprunteur +9,9 XRP + broker owner +0,1 XRP (origination). `AssetsTotal` inchangé (créance = actif), `AssetsAvailable` −10. Cover intact. `DebtTotal` +10 XRP + intérêts. L'objet Loan porte `PeriodicPayment: "5000010.70205804189"` — **une valeur décimale sub-drop stockée dans le ledger**. | 📖 |
| 77 | Fenêtre de `LoanPay` | À échéance+5 s : sous-paiement, paiement exact, tout → **`tecEXPIRED`**. **La fenêtre de paiement se ferme À l'échéance** ; en retard il faut `tfLoanLatePayment` (X3). Sur-paiement sans flag posé à la création du prêt → `tecNO_PERMISSION`. | ⚠️📖 |
| 78 | `LoanPay` par un tiers | `tecNO_PERMISSION` — seul l'emprunteur paie. | ✅ |
| 79 | Remboursement anticipé intégral | `tfLoanFullPayment` avant l'échéance → **`tecKILLED`** (encore le code des offres). Retesté en X4. | ⚠️ |
| 80 | Prêt soldé | **L'objet Loan survit au dernier paiement** (champs d'encours purgés, `Flags=0`). Il faut un `LoanDelete` explicite : par l'**emprunteur** → `tesSUCCESS` (objet supprimé) ; sur un prêt non soldé → `tecHAS_OBLIGATIONS`. | 📖 |

---

## Campagne G — défaut, impairment, qui encaisse la perte

Décor : vault 30 XRP (30M parts, NAV 1). Trois brokers : B1 (rates 10000/50000, cover 5 XRP), B2 (0/0, cover 0), B3 (10000/50000, cover 1 XRP). Prêts : L1 4 XRP (B1), L2 6 XRP (B2), L3 8 XRP (B3).

| # | Cas | Résultat | Verdict |
|---|---|---|---|
| 81 | Impair **avant** échéance | `tecTOO_SOON`. | ✅ |
| 82 | Impair **pendant la grâce** | **`tesSUCCESS`** — la grâce ne protège pas de l'impairment, seulement du défaut. | ⚠️📖 |
| 83 | Impair après échéance+grâce | `tesSUCCESS`. `LossUnrealized = 4 000 000` (= principal restant, hors intérêts). ⚠️ `AssetsTotal` ne bouge pas : la NAV « prudente » doit se calculer **(AssetsTotal − LossUnrealized)/parts** à la main. | 📖 |
| 84 | Unimpair | Réversible à 100 % : `LossUnrealized` → 0, `Flags` → 0. Seule trace : `account_tx`. | ✅ |
| 85 | **Défaut, perte < cover** | Perte 4 XRP, cover 5 XRP : le vault ne récupère que **0,2 XRP** ! Ponction = `principal × CoverRateMinimum × CoverRateLiquidation` = 4M × 10 % × 50 % = 0,2M. AssetsTotal 16,4→12,6 ; cover 5→4,8. **NAV 0,547→0,42**. Les déposants mangent 3,8 XRP sur 4 alors que le cover aurait tout couvert. | ⚠️⚠️ **la** découverte |
| 86 | Défaut à cover **zéro** | AssetsTotal 30→24 (−100 % du principal), NAV 1→0,8, cover 0→0. **Les déposants absorbent tout.** | ⚠️ confirmé |
| 87 | Perte > cover | Perte 8 XRP, cover 1 XRP : ponction 0,4 XRP (= 8M×10 %×50 %), reliquat 7,6 XRP sur les déposants. NAV 0,8→0,547. | ⚠️ |
| 88 | Après défaut | **L'objet Loan survit**, `Flags=lsfLoanDefault (65536)`, champs d'encours purgés. Tout l'historique est dans `account_tx` du pseudo-compte (7 `LoanManage` visibles). | 📖 |
| 89 | Défaut **non déclaré** | 279 s après échéance+grâce : objet strictement inchangé, `LossUnrealized=0`, rien ne force le broker, **rien n'est visible on-ledger** sans comparer `NextPaymentDueDate+GracePeriod` à l'heure. | ⚠️ confirmé |
| 90 | Payer un prêt impairé | `tecEXPIRED` (car en retard) — voir X8 pour le cure avec `tfLoanLatePayment`. | 📖 |
| 91 | Redemption avec prêt vivant | Retrait total → `tecINSUFFICIENT_FUNDS`. Retrait calé sur `AssetsAvailable` → `tesSUCCESS` (41/50 XRP récupérés). Le solde des parts reste adossé à la créance. | ✅ mesuré |

---

## Campagne H — lecture et observabilité

| # | Cas | Résultat |
|---|---|---|
| 92 | RPC disponibles | `vault_info` existe. **`loan_info`, `loan_broker_info`, `mpt_holders` : `unknownCmd`**. `ledger_entry` accepte les filtres typés `vault:`, `loan:`, `loan_broker:`, `mpt_issuance:` et l'`index` brut. |
| 93 | `vault_info` vs objet brut | `vault_info` = objet ledger + le champ synthétique `shares` (l'issuance). Rien ne manque. ⚠️ `AssetsTotal`/`AssetsAvailable`/`LossUnrealized` **disparaissent** de la réponse quand ils valent 0. |
| 94 | Pseudo-compte | Porte `LoanBroker` et `MPTokenIssuance`. `Flags=26214400` (lsfDisableMaster + lsfDepositAuth + …), pas de RegularKey. |
| 95 | `account_tx` pseudo-compte | Voit tout : VaultCreate, VaultDeposit, LoanBrokerSet, LoanSet, **LoanManage** (défauts). |
| 96 | `subscribe` | ✅ événements temps réel reçus (h96 : dépôt validé → 1 événement). Nuance : une tx **en échec `tec`** visant le vault n'apparaît PAS sur le stream du pseudo-compte (elle n'affecte que l'émetteur). |
| 97 | `simulate` | Fonctionne sur VaultCreate/VaultDeposit/LoanManage/LoanPay et rend le bon code sans appliquer. **`LoanSet` n'est PAS simulable sans co-signature** (`temBAD_SIGNER`) — impossible de pré-vérifier le cas d'usage le plus fragile. |
| 98 | `server_definitions` vs codec 2.11.0 | Le codec couvre 100 % du serveur. Il connaît même 4 champs de plus (`IssuerKeyEpoch`, `AuditorKeyEpoch`, + miroirs) absents du Devnet. |
| 99 | Coût de reconstruction | Vault 3 brokers / 3 prêts : **6 appels** (1 vault_info + 1 account_objects brokers + 3 account_objects loans + 1 page account_tx). Formule : `2 + nb_brokers + pages_account_tx`. Pas de descente directe vault→prêts. |

---

## Campagne I — actifs IOU et MPT (+ i2)

| # | Cas | Résultat | Verdict |
|---|---|---|---|
| 100 | Cycle complet IOU (Scale 6) | Création, dépôt (100 USD → 100M parts), broker, cover 20 USD, prêt 50 USD, remboursement tardif flaggé : tout passe. | ✅ |
| 101 | `Scale` et précision | 1 part = 10⁻⁶ USD en Scale 6. Un montant à 15 décimales est tronqué à l'échelle, sans perte au retrait (C-34b). | ✅ |
| 102 | **`VaultClawback`** | L'émetteur saisit 30 USD de la position d'un déposant : `AssetsTotal` −30, parts du déposant brûlées 1:1, `tesSUCCESS`. Clawback **supérieur à la position** : `tesSUCCESS`, écrêté — **la position est vidée à zéro**. `LoanBrokerCoverClawback` fonctionne aussi (cover 20→15). | ⚠️ voir SECURITY |
| 103 | Cycle complet MPT | Création, dépôt, broker, prêt, remboursement : tout passe. | ✅ |
| 103b | **Prêt MPT à un emprunteur sans `MPToken`** | `tesSUCCESS` — **le `LoanSet` auto-crée le holding MPT** de l'emprunteur (vérifié : solde 4000 après deux prêts de 2000). | ⚠️📖 |
| 104 | Vault dont l'actif = parts d'un autre vault | **`tecWRONG_ASSET`** — pas de vaults-gigognes, la récursion est fermée. | ✅ |
| 105 | **Prêt IOU à un emprunteur sans trustline** | `tesSUCCESS` — **le `LoanSet` auto-crée une trustline** (limit 0) chez l'emprunteur, qui reçoit 10 USD sans jamais avoir opté pour l'IOU. | ⚠️📖 |
| 106 | `tfGlobalFreeze` | Sur vault open-ended (isolé du bruit de phase) : dépôt, retrait **et `LoanPay` → `tecFROZEN`** ; dégel → tout repart. ⚠️ Ordre des checks : la phase passe avant le gel (en Investment on voit `tecEXPIRED`/`tecTOO_SOON`, pas `tecFROZEN`). **Pendant un gel, les déposants ne peuvent PAS sortir.** | 📖 |
| — | Piège d'API relevé au passage | `LoanPay` d'un prêt IOU avec un Amount en drops → **`tecWRONG_ASSET`** (code clair, bien). | ✅ |

---

## Campagne J — limites et cas tordus

| # | Cas | Résultat | Verdict |
|---|---|---|---|
| 107 | `AssetsMaximum` abaissé sous `AssetsTotal` | `tecLIMIT_EXCEEDED`. Exactement égal : OK. Retour à `0` (illimité) : OK. | ✅ |
| 108 | `Payment` → pseudo-compte | `tecNO_PERMISSION`. | ✅ |
| 113 | `EscrowCreate` / `CheckCreate` / `PaymentChannelCreate` → pseudo-compte | **`tecNO_PERMISSION` les trois** — aucun canal de subvention ni de pollution d'objets. | ✅ |
| 109 | Vault-tx dans un `Batch` | **`temINVALID_INNER_BATCH` « Malformed: Invalid inner batch transaction. »** — `kDisabledTxTypes` confirmé au niveau du code de rejet. | ✅ |
| 110 | Privilège du propriétaire ? | Aucun : retrait en Investment → `tecTOO_SOON` comme tout le monde. | ✅ |
| 111 | **Self-loan** (même compte = owner du vault, du broker, ET emprunteur, co-signé avec lui-même) | **`tesSUCCESS`** — parfaitement légal. Combiné à un broker 0/0 : recette de rug-pull complète (voir SECURITY-NOTES). | ⚠️⚠️ |
| 112 | `AccountDelete` en détenant des parts | Refusé — mais le message liste « Escrows, PayChannels, RippleStates, Checks, or Sponsorships » **sans mentionner les MPToken**, qui sont pourtant la cause. Après retrait + fermeture du MPToken : `tesSUCCESS`. | 🐛 message |
| 114 | **La facture réserve/frais de la chaîne complète** | `VaultCreate` : **0,2 XRP brûlés** + **3 OwnerCount** pour le créateur (0,6 XRP de réserve). `LoanBrokerSet` : +2 OwnerCount. `LoanSet` : +1 OwnerCount (emprunteur). Les **pseudo-comptes vivent avec Balance=0** (exemptés de réserve, `Flags=26214400` = lsfDisableMaster+lsfDepositAuth). Chaîne vault+broker+1 prêt : 0,2 XRP brûlés + 1,2 XRP de réserve owner. | 📖 |

---

## Campagne X — contre-essais

| # | Cas | Résultat | Verdict |
|---|---|---|---|
| X1 (54) | Mutabilité du broker | **`DebtMaximum` : mutable** (`tesSUCCESS`, vérifié sur l'objet). **`Data` : mutable**. **`ManagementFeeRate` : immuable** (`temINVALID` serveur). `CoverRate*` : le SDK refuse un champ seul (« both zero or both non-zero ») — voir X9 pour l'update des deux ensemble. | 📖 |
| X2 (69) | Marge de fin de prêt, affinée | Échec à red−70 s, succès dès red−85 s (grace non comptée). Règle plausible : « dernière échéance ≤ RedemptionDate − 60 s » **mesurée en temps ledger** (close time parente + résolution 10 s) → en pratique **budgéter ≥ 90 s**. Code : `tecNO_PERMISSION`. | 📖 |
| X3 (77/73) | Fenêtre `LoanPay` + flux | Paiement **en avance dans la période : `tesSUCCESS`**. Flux mesuré au drop : emprunteur −5 010 019 = échéance 5 000 018 + service fee 10 000 + fee tx 1 ; pseudo-vault +5 000 018 ; **service fee 10 000 → directement au compte du broker owner** ; `AssetsTotal` +24 drops (l'intérêt encaissé, cash-basis confirmé). Le management fee s'accumule en `ManagementFeeOutstanding` sur l'objet Loan (2 drops observés sur LF à fee 10 %) — flux trop petits à notre échelle pour tracer son versement. | 📖 |
| X3 (77) | Retard | Après l'échéance : sans flag → `tecEXPIRED` ; avec **`tfLoanLatePayment` → `tesSUCCESS`**. Flux : emprunteur paie échéance + service fee + **late fee 50 000 drops**, et service + late fee vont tous deux **au compte du broker owner**. Le prêt se solde ensuite normalement. | 📖 |
| X4 (77/79) | Sur-paiement / remboursement anticipé | Prêt créé avec `Flags: tfLoanOverpayment` (objet : `lsfLoanOverpayment=262144`) : **sur-paiement partiel accepté** (principal 5→2 XRP en milieu de période). Mais le **remboursement intégral anticipé reste refusé : `tecKILLED`**, même flaggé. Aucun chemin trouvé pour solder un prêt avant son terme. | ⚠️🐛 |
| X5 (64) | Multisig `CPM\0` | **`tesSUCCESS`** avec les `Signers` triés par **ID binaire** (le tri lexicographique donne « Counterparty: Unsorted Signers array »). Le helper multisig du SDK reste cassé (mauvais préfixe). | 🐛 SDK |
| X6 | Checks serveur bruts (sans la validation SDK) | **Toutes** les violations `VaultCreate` (gap 179 s, gap 31 ans, closed sans dates, `VaultKind` 0 ou 2, `Scale` sur XRP, `DomainID` sans flag) → **`temMALFORMED` « Malformed transaction. »** nu, zéro indication de champ. Les messages utiles n'existent **que** dans xrpl.js. `LoanBrokerSet` (un seul rate, fee 20000) → `temINVALID` nu. | 🐛 DX serveur |
| X7+Y1 (58) | Plancher du cover | Le plancher n'est **ni** `DebtTotal × CoverRateMinimum` **ni** exactement `DebtTotal × CoverRateLiquidation` : à dette 9,50 XRP, laisser 0,95 XRP (=min) est refusé ; à dette 5,00 XRP, descendre 1 drop **sous** dette×liq passe encore. La formule exacte (probablement par prêt, avec arrondis) n'est **documentée nulle part** et n'est pas reconstructible à l'aveugle — données brutes dans out/x.json et out/y.json. | 📖 trou de doc |
| X8 (89/90) | Prêt à l'abandon, en Redemption | Le prêt en retard de 1831 s : **cure tardif accepté** (`LoanPay` + `tfLoanLatePayment` → `tesSUCCESS`), puis **impair et défaut fonctionnent aussi en Redemption**. Après le défaut : AssetsTotal 9,00→6,50 XRP, AssetsAvailable inchangé — les 9M parts restantes de D valent NAV 0,72. `LoanManage`/`LoanPay` ignorent donc les phases : seule la **création** de prêt est fenêtrée. | 📖 |
| Y2 (54) | Update des deux CoverRate ensemble | **`temINVALID` (serveur)** — les CoverRate sont réellement immuables, objet inchangé. | ✅ |

---

## Annexe Z — enquête post-beta.1 : le « prêt soldé fantôme »… et la vraie découverte (12/09)

**Symptôme** : deux runs du test d'intégration voyaient un `LoanPay` de 4 XRP rendre
`tesSUCCESS`, puis l'objet Loan passer **en forme « soldé »** (champs d'encours purgés)
après une seule échéance, et `tfLoanImpair`/`tfLoanDefault` sortir en **`tecNO_PERMISSION`**
— un code jamais vu sur LoanManage pendant les campagnes.

**Enquête** (rippled inchangé : 3.4.0-rc5, mêmes amendements) :

| Sonde | Scénario | Résultat |
|---|---|---|
| `z-impair-final.mjs` | impair en période finale (éch. 1 payée) + contrôle jamais payé | tout `tesSUCCESS` |
| `z2-loanpay-generous.mjs` | LoanPay généreux à due+2 s wall | `tecEXPIRED` propre ; impair/défaut OK avec marge +20 s |
| `z3-boundary-pay.mjs` | timing exact de l'intégration | débit exact du périodique, champs intacts, impair+défaut OK |
| `z4-early-payoff.mjs` | **la clé** — voir ci-dessous | |

**Cause réelle** : un bug du test lui-même — `principal: 6` = **6 drops**, pas 6 XRP
(le helper attend des drops). Le `LoanPay` de 4 000 000 drops couvrait donc tout le
TVO (6 drops) → **le prêt a été intégralement soldé en un paiement, sans aucun flag** →
champs purgés → `LoanManage` sur prêt soldé = `tecNO_PERMISSION` (code cohérent, mystère résolu).

**La vraie découverte (Z4, à échelle réelle — prêt 6 XRP, interval 120, total 2, mi-période 1)** —
elle **corrige F-79/X4** (« aucun remboursement anticipé possible ») :

| Cas | Résultat | Débit mesuré |
|---|---|---|
| `Amount = TVO + 1 XRP`, **sans flag** | `tesSUCCESS` — **prêt soldé** | **6 000 018** (= TVO exact, intérêt couru compris) |
| `Amount = TVO` exact, sans flag | `tesSUCCESS` — soldé | 6 000 018 |
| `Amount = TVO + 1 XRP`, avec `tfLoanFullPayment` | `tesSUCCESS` — soldé | **6 000 000** (= principal seul : **l'intérêt couru est remis** !) |

Donc : le remboursement anticipé intégral **existe** — `LoanPay` avec `Amount ≥ TVO`
solde le prêt même en milieu de période, et le flag `tfLoanFullPayment` fait mieux :
il **annule l'intérêt couru**. Les `tecKILLED` de F-79/X4 avaient tous deux
`PaymentRemaining = 1` : le refus semble spécifique à la **dernière période** de
l'échéancier (hypothèse cohérente avec tous les points de mesure, à confirmer en
lisant la source de rippled). `LoanManage` sur un prêt soldé rend `tecNO_PERMISSION`.

Mitigations : le test d'intégration paie le périodique exact tôt dans la période et
attend `due+grace+20 s` (marge temps-ledger [B2/X2]) avant tout LoanManage ;
FRICTIONS n°6 requalifiée.
