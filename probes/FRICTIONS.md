# Frictions développeur — XLS-65/66 sur Devnet (rapport jury)

Environnement : Devnet public, rippled 3.4.0-rc5 (`LendingProtocolV1_1`), `xrpl.js@5.2.0-beta.1`, `ripple-binary-codec@2.11.0`. Chaque entrée est reproduite par un script de `probes/` ; les codes et messages exacts sont dans `probes/out/*.json`.

Format : **catégorie** · **titre** · description · repro · **sévérité** · lib/version.

> ## ⚠️ Mise à jour — `xrpl.js@5.2.0-beta.1` (12/09)
>
> Le Notion a basculé de `5.2.0-beta.0` à **`5.2.0-beta.1`**. Les six frictions
> `client libraries` ont été **revalidées une par une** contre cette version
> (`probes-marche/06-revalidation-beta1.mjs`) :
>
> | # | Friction | État en beta.1 |
> |---|---|---|
> | 1 | co-signature `LoanSet` invalide | ✅ **CORRIGÉE** — table `SIGNING_ENCODERS` par rôle, revérifiée sur la chaîne |
> | — | rejet aux *local checks* levé en exception | ❌ ouverte |
> | — | `signMultiBatch` sans `Flags` → `Error` brute | ❌ ouverte |
> | 15 | `LoanBrokerSet` en update exige `VaultID` | ❌ ouverte |
> | — | `console.warn` de `autofill` non désactivable | ❌ ouverte (2 occurrences dans `sugar/autofill.js`) |
> | 17 | tri des `Signers` en multisig | ⚠️ **requalifiée** — `combineLoanSetCounterpartySigners` trie via `compareSigners` ; le piège ne concerne que le montage à la main |
>
> Restent ouverts sur la n°1 : la config CI s'arrête toujours à `fixCleanup3_2_0`,
> et `xrpl-py` porte encore le même bug.
> Les frictions `protocol` et `documentation/tutorials` ci-dessous **n'ont pas été
> revalidées** : elles dépendent de rippled, pas du SDK, et le nœud n'a pas changé.

---

---

## Sévérité HAUTE

**1 · client libraries · `signLoanSetByCounterparty` produit une co-signature invalide (simple ET multisig)**
Le helper signe avec le préfixe historique `STX\0` alors que `fixCleanup3_4_0` (actif) exige `CPT\0` en simple et `CPM\0` en multisig. Le nœud refuse la transaction **aux local checks** (`invalidTransaction: fails local checks: Counterparty: Invalid signature.`) et xrpl.js remonte ça en **exception WebSocket** qui crashe un flux `submitAndWait` non protégé. Les bons encodeurs (`encodeForSigningCounterparty`, `encodeForMultisigningCounterparty`) existent déjà dans ripple-binary-codec 2.11.0 mais ne sont pas appelés. Aucun `LoanSet` co-signé ne peut aboutir avec le SDK seul — c'est la transaction centrale de XLS-66.
Repro : `probes/campaign-f2.mjs` (63.sdk vs 63.fix) ; contournement 4 lignes dans `PATCH-loanset-counterparty.md` ; preuve du fix : https://devnet.xrpl.org/transactions/A8A1EC0892A5C1863833EE8317A231EED4E1CCE725664F464AFD68445AB3D559 · **haute** · xrpl.js 5.2.0-beta.0.

**2 · documentation/tutorials · La contrainte `60 ≤ GracePeriod ≤ PaymentInterval` n'est écrite nulle part et sort en `temINVALID` générique**
Tout `LoanSet` avec `GracePeriod < 60` ou `> PaymentInterval` (donc aussi tout `PaymentInterval < 60`) échoue en `temINVALID` « The transaction is ill-formed » — zéro indication de champ. Balayage : grace 59 ❌ / 60 ✅ / = interval ✅ / interval+1 ❌. Nous avons perdu une session de debug complète dessus (trois hypothèses fausses avant le balayage).
Repro : `probes/g-sweep.mjs` · **haute** · rippled 3.4.0-rc5.

**3 · UX · Côté serveur, TOUTE violation de `VaultCreate` = `temMALFORMED` nu**
Gap de dates hors [180 s, ~30 ans), dates manquantes, `VaultKind` inconnu, `Scale` sur XRP, `DomainID` sans flag privé : le serveur répond « Malformed transaction. » sans jamais nommer le champ. Les messages utiles (« RedemptionDate − SubscriptionDate must be within [180, 946708560) seconds », etc.) n'existent **que dans la validation client de xrpl.js** — un SDK tiers ou un intégrateur brut n'a rien.
Repro : `probes/campaign-x.mjs` (X6.*) vs `probes/campaign-a.mjs` (2-8) · **haute** · rippled 3.4.0-rc5.

**4 · missing primitive · Pas de `loan_info`, `loan_broker_info` ni `mpt_holders` — et `LoanSet` est insimulable**
Reconstituer un vault = traversée obligatoire à 3 niveaux (`vault_info` → `account_objects type:loan_broker` sur le pseudo-compte → `account_objects type:loan` par broker), soit `2 + nb_brokers (+ pages account_tx pour les porteurs)` appels — mesuré : 6 appels pour 3 brokers/3 prêts, la liste des porteurs exigeant un **rejeu complet d'`account_tx`**. Et `simulate` refuse `LoanSet` sans co-signature (`temBAD_SIGNER`) : la transaction la plus difficile à construire est la seule qu'on ne peut pas pré-vérifier.
Repro : `probes/campaign-h.mjs` (92, 97, 99) · **haute** · rippled 3.4.0-rc5.

**5 · UX · La fenêtre de `LoanPay` se ferme À l'échéance, et le code est `tecEXPIRED`**
Payer 5 s après `NextPaymentDueDate` → `tecEXPIRED` ; il faut deviner le flag `tfLoanLatePayment` (aucun message ne le suggère). Le même `tecEXPIRED` signifie aussi : dépôt hors Subscription, `LoanSet` en Redemption, credential expiré — quatre sens pour un code, indiscernables sans relire les dates du vault. À l'inverse, payer en avance dans la période fonctionne.
Repro : `probes/campaign-f3.mjs` (77) et `campaign-x.mjs` (X3) ; paiement tardif flaggé : https://devnet.xrpl.org/transactions/CC875E06C91F72DACEF06435ECD2BA0FC82588EA1DAA46B0AEE013F81B27E1E1 · **haute** · rippled 3.4.0-rc5.

---

## Sévérité MOYENNE

**6 · UX · `tecKILLED` « No funds transferred and no offer created. » sur des prêts** *(requalifiée le 12/09 — voir RESULTATS annexe Z)*
Deux chemins de lending sortent avec le code et le message du DEX : (a) `PaymentTotal` énorme (overflow d'échéancier), (b) le remboursement intégral en **dernière période** de l'échéancier (`PaymentRemaining = 1`), flag ou pas. ~~« Aucun chemin pour solder un prêt avant terme »~~ — **faux, requalifié** : en milieu d'échéancier, `LoanPay` avec `Amount ≥ TotalValueOutstanding` **solde le prêt sans aucun flag** (débit = TVO exact), et `tfLoanFullPayment` solde en ne débitant **que le principal** (l'intérêt couru est remis — comportement puissant et non documenté). La friction restante : (1) le `tecKILLED` de dernière période avec son message DEX, (2) trois sémantiques de solde différentes selon flag/période, écrites nulle part, (3) `LoanManage` sur un prêt soldé → `tecNO_PERMISSION`, indiscernable d'un problème de droits.
Repro : `probes/z4-early-payoff.mjs` (3 cas mesurés au drop) vs `probes/campaign-x.mjs` (X4.full, dernière période), https://devnet.xrpl.org/transactions/E957E2A7DBD6EA7CA771E5D046CC11EED78F79AA9A7D96C5C6959A068B09F08F · **moyenne** · rippled 3.4.0-rc5.

**7 · documentation/tutorials · Trois champs « rate », trois sémantiques, zéro doc**
Mesuré empiriquement : `InterestRate` est **annualisé** en 1/100 000 (10 XRP à 100000 → 64 drops d'intérêt en 200 s = 10M × 100 % × 200/31 536 000). `CoverRateMinimum`/`CoverRateLiquidation` sont des ratios instantanés en 1/100 000, mais la ponction au défaut = `principal × min × liq` (la liquidation s'applique à la **tranche**, pas à la dette). `ManagementFeeRate` est borné à [0, 10000]. Le plancher exact de `LoanBrokerCoverWithdraw` avec dette n'a pas pu être reconstruit empiriquement (ni dette×min ni dette×liq au drop près) — il faut lire la source de rippled.
Repro : `probes/campaign-f3.mjs` (72), `campaign-g2.mjs` (85-87), `campaign-e.mjs` (55), `y-followup.mjs` · **moyenne** · rippled 3.4.0-rc5.

**8 · documentation/tutorials · La contrainte de fin de prêt vs `RedemptionDate` : marge réelle ~90 s, code `tecNO_PERMISSION`**
La règle nominale (« dernière échéance ≤ RedemptionDate − 60 s », grâce non comptée) se mesure en **temps ledger** (close time parente, résolution 10 s) : à l'horloge murale, red−61 s échoue encore et il faut viser ~red−85 s. Le code est `tecNO_PERMISSION` — rien à voir avec une permission.
Repro : `probes/campaign-f3.mjs` (69), `campaign-x.mjs` (X2) · **moyenne** · rippled 3.4.0-rc5.

**9 · UX · La bascule de phase a ~5-12 s de flou, et la paire de codes est asymétrique**
Le check de phase utilise la close time du **ledger parent** (retard d'un ledger + résolution 10 s) : un dépôt atterrissant dans un ledger fermé 8 s **après** `SubscriptionDate` passe encore ; un retrait dans le même ledger autour de `RedemptionDate` échoue encore. Codes : dépôt hors fenêtre → `tecEXPIRED`, retrait trop tôt → `tecTOO_SOON`.
Repro : `probes/campaign-b2.mjs` (5 comptes, tirs à ±2 s des deux frontières) · **moyenne** · rippled 3.4.0-rc5.

**10 · UX · `vault_info` fait disparaître les champs à zéro**
`AssetsTotal`, `AssetsAvailable`, `LossUnrealized` sont absents de la réponse quand ils valent 0 (sérialisation default-value). Tout client doit défendre chaque lecture par `?? '0'` — notre propre harnais a crashé dessus. Et la NAV « prudente » doit se calculer à la main : `AssetsTotal` ne bouge pas à l'impairment, seul `LossUnrealized` monte.
Repro : `probes/campaign-c.mjs` (vault vidé), `campaign-g2.mjs` (83) · **moyenne** · rippled 3.4.0-rc5.

**11 · other · `LoanSet` crée la trustline / le MPToken de l'emprunteur d'office**
Un emprunteur **sans trustline** reçoit un prêt IOU (`tesSUCCESS`, trustline limit 0 auto-créée) ; idem en MPT (holding auto-créé). Aucun opt-in de l'emprunteur sur l'actif — surprenant vs le reste de XRPL où recevoir un IOU exige une trustline.
Repro : https://devnet.xrpl.org/transactions/8A704369224F548BE55A9F769628242D01FA5368B957E94353B3F8287375F4C1 (IOU) et https://devnet.xrpl.org/transactions/445B64265278E333895DBB485A9AECA7E105ED57D1EBF7C9E83603F3A599E2DD (MPT) · **moyenne** · rippled 3.4.0-rc5.

**12 · documentation/tutorials · `Data` de `LoanSet` : validé puis silencieusement jeté ; `StartDate` : rejet cryptique**
`Data` passe la validation (256 octets max) puis **n'apparaît pas sur l'objet Loan** — quiconque y stocke une référence la perd sans erreur. `StartDate`, champ légitime de l'**objet** Loan, est refusé sur la **transaction** avec « Field 'StartDate' found in disallowed location. » — même message que pour les dates de `VaultSet`, qui n'explique pas que le champ est dérivé.
Repro : https://devnet.xrpl.org/transactions/1634B565376D44084DC29F94ABF8DD3C435055F1759EE5D5536D85380D830D41 (Data jeté) · **moyenne** · rippled 3.4.0-rc5.

---

## Sévérité BASSE

**13 · UX · `tecPATH_DRY` pour un dépassement de capacité des parts**
Vault IOU `Scale: 18` : le dépôt qui porterait l'offre de parts au-delà de 2⁶³−1 échoue en `tecPATH_DRY` — un code de pathfinding pour un overflow d'émission.
Repro : https://devnet.xrpl.org/transactions/7262AA284B77394DBF4A81734BC4BBD5B6BBFDFA2213A8BDE5059821ED328E1E · **basse** · rippled 3.4.0-rc5.

**14 · UX · Le message d'`AccountDelete` ne mentionne pas les MPToken**
Un compte détenteur de parts ne peut pas être supprimé (bien), mais le message liste « Escrows, PayChannels, RippleStates, Checks, or Sponsorships » — pas les MPToken, qui sont la cause réelle.
Repro : `probes/campaign-j.mjs` (112) · **basse** · rippled 3.4.0-rc5.

**15 · client libraries · L'update d'un `LoanBroker` exige `VaultID` côté SDK**
`LoanBrokerSet` avec `LoanBrokerID` seul → erreur SDK « missing field VaultID » alors que l'ID du broker suffit à l'identifier. Au passage, seule la paire (`DebtMaximum`, `Data`) est mutable ; `ManagementFeeRate` et les `CoverRate*` sont immuables (`temINVALID` serveur, là encore sans explication).
Repro : `probes/campaign-e.mjs` (54) vs `campaign-x.mjs` (X1) · **basse** · xrpl.js 5.2.0-beta.0.

**16 · other · `PeriodicPayment` est un décimal fractionnaire stocké dans le ledger**
L'objet Loan d'un prêt en drops porte `PeriodicPayment: "5000017.836765632213"` — des fractions de drop dans un objet ledger. Les intégrateurs qui parsent en entier casseront.
Repro : `probes/out/f3.json` (76) · **basse** · rippled 3.4.0-rc5.

**17 · client libraries · Multisig de co-signature : tri des `Signers` par ID binaire exigé**
`CPM\0` fonctionne, mais avec les Signers triés par **ID de compte décodé** ; un tri lexicographique des adresses r… donne « Counterparty: Unsorted Signers array » aux local checks. Rien dans le SDK n'aide (son helper multisig est de toute façon cassé, cf. friction 1).
Repro : `probes/campaign-x.mjs` (X5, tesSUCCESS) vs `campaign-f3.mjs` (64) · **basse** · xrpl.js 5.2.0-beta.0.

---

## Points positifs à verser au dossier (anti-frictions)

- **Pas d'enfermement par design** : `SubscriptionDate`/`RedemptionDate` ne sont pas des champs de `VaultSet` (rejet local systématique) ; un membre exclu, expiré ou révoqué d'un domaine peut **toujours retirer** ; le gel IOU (`tecFROZEN`) est le seul cas de sortie bloquée, et il est réversible.
- **Le pseudo-compte est étanche** : `Payment`, `EscrowCreate`, `CheckCreate`, `PaymentChannelCreate` → `tecNO_PERMISSION` ; vault-tx en Batch → `temINVALID_INNER_BATCH` ; vault de parts de vault → `tecWRONG_ASSET`.
- **Aucune fuite d'arrondi** : 100 aller-retours XRP, 30 en IOU Scale 6, 15 en Scale 18 à 16 décimales — soldes au drop/à la décimale près ; `holderMap` par rejeu d'`account_tx` réconcilie exactement `OutstandingAmount` dans tous nos scénarios (transferts et fermetures de MPToken compris).
- **La course retrait-de-cover vs `LoanSet` co-signé est saine** : l'ordre d'application décide et le `LoanSet` perdant échoue proprement (`tecINSUFFICIENT_FUNDS`).
- `simulate` fonctionne (avec les bons codes, sans appliquer) sur tout sauf `LoanSet`.
