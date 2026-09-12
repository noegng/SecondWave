# SecondWave — Plan de build final (Track 2, Closed-Ended Vault V1.1)

Fusion de `PLAN_SecondWave.md` (marketplace + RiskLens) et `PLAN_SecondWave_v1.1.md` (Track 2 closed-ended), corrigée avec les **commandes réelles** vérifiées le 2026-09-12 via le MCP xrpl.org, Context7 (`/xrplf/xrpl.js`), le source `rippled` et un sondage direct de Devnet.

---

## 0. Faits vérifiés (source de vérité)

| Fait | Valeur | Source |
|---|---|---|
| Devnet | `wss://s.devnet.rippletest.net:51233`, build `3.4.0-rc5` | `server_info` |
| Faucet | `https://faucet.devnet.rippletest.net/accounts` (ou `client.fundWallet()`) | xrpl.org |
| Amendements **activés** | `SingleAssetVault`, `LendingProtocol`, `LendingProtocolV1_1`, `BatchV1_1`, `MPTokensV1`, `DynamicMPT`, `TokenEscrow`, `PermissionedDomains`, `Credentials` | `feature` |
| Amendement **absent** | `MPTokensV2` (XLS-82, DEX pour MPT) → **pas d'`OfferCreate` sur les parts MPT** | `feature` + xrpl.org Known Amendments |
| Champs V1.1 présents | `VaultKind` (UInt8), `SubscriptionDate`, `RedemptionDate` (UInt32, Ripple epoch), `LEVersion`, `Borrower`, `LoanID` | `server_definitions` |
| `VaultKind` | `0 = OpenEnded`, `1 = ClosedEnded` | `rippled/include/xrpl/protocol/Protocol.h` |
| Contrainte de dates | `180 s ≤ RedemptionDate − SubscriptionDate < 30 ans`, sinon `temMALFORMED` ; date passée → `tecEXPIRED` | `VaultCreate.cpp`, `Protocol.h` |
| Phases du coffre fermé | `Subscription` (jusqu'à `SubscriptionDate` inclus) → `Investment` → `Redemption` (à partir de `RedemptionDate`) | `VaultHelpers.cpp::getVaultPhase` |
| `VaultDeposit` hors Subscription | **`tecEXPIRED`** | `VaultDeposit.cpp` |
| `VaultWithdraw` en Investment | **`tecTOO_SOON`** ← le garde-fou obligatoire du Track 2 | `VaultWithdraw.cpp` |
| `LoanSet` en Subscription | `tecTOO_SOON` ; en Redemption `tecEXPIRED` ; dernière échéance + 60 s > `RedemptionDate` → `tecNO_PERMISSION` | `LoanSet.cpp`, `kLoanRedemptionBuffer = 60` |
| `LoanSet.PaymentInterval` min | 60 s | `LoanSet.h::kMinPaymentInterval` |
| `LoanBrokerSet` | Le soumetteur **doit être `Vault.Owner`** (`tecNO_PERMISSION` sinon) ; 2 owner reserves | xrpl.org + XLS-66 |
| Taux | 1/10 bps : `500 = 0,5 %`, `100000 = 100 %` ; `ManagementFeeRate ≤ 10000` | xrpl.org LoanBrokerSet |
| Parts de coffre | MPT émis par le pseudo-compte, flags `CanEscrow|CanTrade|CanTransfer` (+ `RequireAuth` si privé) ; `tfVaultShareNonTransferable` les rend intransférables — **ne pas l'utiliser** | `VaultCreate.cpp` |
| `xrpl.js` | `5.2.0` (2026-09-11). Codec encode `VaultKind/SubscriptionDate/RedemptionDate` ✔, **mais l'interface TS `VaultCreate` ne les déclare pas** (cast requis). `LoanSet` TS ne déclare pas `Borrower/LoanID` (flux 2 étapes V1.1) | `npm view`, `dist/npm/models` |
| Helpers `xrpl.js` | `signLoanSetByCounterparty`, `combineLoanSetCounterpartySigners`, `signMultiBatch(wallet, batch)`, `combineBatchSigners([...])`, `encodeMPTokenMetadata`, `VaultCreateFlags`, `LoanManageFlags`, `BatchFlags` | probe local |
| Lecture on-chain | `vault_info { vault_id }`, `ledger_entry { loan_broker }`, `ledger_entry { loan: { loan_broker_id, loan_seq } }`, `account_objects` | xrpl.org |

---

## 1. Décisions d'architecture qui découlent des faits

1. **Règlement de la marketplace = `Batch` multi-comptes `tfAllOrNothing`**, pas le DEX.
   Sans `MPTokensV2`, un `OfferCreate` sur les parts échoue. Le swap atomique « parts MPT Alice→Bob » + « cash MPT Bob→Alice » se fait en une seule transaction `Batch` (2 inner `Payment`, 2 `BatchSigners`), soumise par le compte orchestrateur SecondWave. C'est aussi un argument produit : SecondWave *est* le carnet d'ordres off-chain + le règlement on-chain.
2. **Coffre fermé public** (pas de `tfVaultPrivate`/`DomainID`) pour la démo. Un coffre privé imposerait des Credentials à Bob avant qu'il puisse recevoir les parts. On documente le cas privé dans le feedback.
3. **Le Vault Owner et le Loan Broker sont le même compte** (`Broker`). C'est une obligation du protocole (`LoanBrokerSet` par `Vault.Owner`).
4. **Actif du coffre = un MPT « USDX »** que nous émettons (simule RLUSD). Bob paie Alice en USDX aussi (simple, un seul MPT à autoriser). Le cash côté marketplace est donc le même actif que le coffre.
5. **Fenêtres temporelles courtes** pour la démo : Subscription ≈ 2 min, Investment ≈ 4 min (gap ≥ 180 s), prêt à 2 échéances de 60 s. Toute la démo tient en < 10 min.
6. **Transactions V1.1 en JSON brut typé `as any`** pour `VaultCreate` (champs manquants dans TS). On garde `xrpl.validate()` — il passe.
7. **Indexeur SQLite + polling `vault_info`/`ledger_entry`** plutôt qu'un stream : les objets `Loan` sont supprimés à la clôture, on snapshotte à chaque étape pour le scoring RiskLens.

---

## 2. Stack & structure du dépôt

```
SecondWave/
├─ apps/web/                 Next.js 15 (App Router) + Tailwind + shadcn — marketplace, fiche courtier, simulateur
├─ packages/chain/           scripts xrpl.js 5.2.0 (ESM, TS) : 00-setup … 09-redeem + lib/
│   ├─ lib/client.ts         connexion Devnet, fundWallet, helpers epoch (xrpl.unixTimeToRippleTime)
│   ├─ lib/state.json        seeds + IDs générés (gitignored)
│   └─ lib/tx.ts             submitAndWait + capture hash/result dans FEEDBACK
├─ packages/indexer/         Node + better-sqlite3 : snapshots Vault/LoanBroker/Loan, scoring RiskLens
├─ packages/engine/          formules pures (Implied APY, RiskScore, stress-test) + tests vitest
├─ FEEDBACK_XLS65_XLS66.md   rapport DevX (livrable 2)
└─ PLAN_BUILD_FINAL.md
```

Dépendances : `xrpl@5.2.0`, `next`, `better-sqlite3`, `zod`, `vitest`. Node ≥ 20.

---

## 3. Étapes de build (dans l'ordre, avec les payloads réels)

### Étape 0 — Bootstrap (30 min)

```bash
npm init -y && npm i xrpl@5.2.0 zod && npm i -D typescript tsx vitest
```

`lib/client.ts` :

```ts
import xrpl from 'xrpl'
export const client = new xrpl.Client('wss://s.devnet.rippletest.net:51233')
export const rippleNow = () => xrpl.unixTimeToRippleTime(Date.now())
export async function fund(n: number) {
  const ws = []; for (let i = 0; i < n; i++) ws.push((await client.fundWallet()).wallet); return ws
}
```

Comptes : `issuer` (USDX), `broker` (= vault owner = loan broker), `alice` (déposante), `bob` (acheteur), `borrower`, `orchestrator` (SecondWave). Sauver les seeds dans `state.json` (gitignored).

### Étape 1 — Émettre l'actif USDX et autoriser les holders (20 min)

```ts
// MPTokenIssuanceCreate
{ TransactionType: 'MPTokenIssuanceCreate', Account: issuer.address, AssetScale: 2,
  Flags: xrpl.MPTokenIssuanceCreateFlags.tfMPTCanTransfer | xrpl.MPTokenIssuanceCreateFlags.tfMPTCanTrade
       | xrpl.MPTokenIssuanceCreateFlags.tfMPTCanEscrow  | xrpl.MPTokenIssuanceCreateFlags.tfMPTCanClawback,
  MPTokenMetadata: xrpl.encodeMPTokenMetadata({ ticker: 'USDX', name: 'SecondWave USD', desc: 'Demo stablecoin', icon: 'https://secondwave.xyz/usdx.png', asset_class: 'rwa', issuer_name: 'SecondWave' }) }
// → mpt_issuance_id = meta.mpt_issuance_id
```

Pour **chaque** holder (`broker`, `alice`, `bob`, `borrower`) : `{ TransactionType: 'MPTokenAuthorize', Account: h.address, MPTokenIssuanceID: usdxId }` puis `Payment` de l'issuer : `Amount: { mpt_issuance_id: usdxId, value: '100000' }`.

### Étape 2 — Créer le Closed-Ended Vault (Minimum bar #1) (20 min)

```ts
const sub = rippleNow() + 120           // fin de souscription dans 2 min
const red = sub + 300                   // rachat 5 min plus tard (gap ≥ 180 s obligatoire)
const vaultCreate = {
  TransactionType: 'VaultCreate', Account: broker.address,
  Asset: { mpt_issuance_id: usdxId },
  VaultKind: 1,                          // ClosedEnded — non typé dans xrpl.js 5.2.0 → `as any`
  SubscriptionDate: sub, RedemptionDate: red,
  WithdrawalPolicy: xrpl.VaultWithdrawalPolicy.vaultStrategyFirstComeFirstServe,
  AssetsMaximum: '0',
  Data: xrpl.convertStringToHex(JSON.stringify({ n: 'SecondWave Closed Fund I', w: 'secondwave.xyz' })),
  MPTokenMetadata: xrpl.encodeMPTokenMetadata({ ticker: 'SWF1', name: 'SecondWave Fund I shares', desc: 'Closed-ended vault shares', icon: 'https://secondwave.xyz/swf1.png', asset_class: 'defi', issuer_name: 'SecondWave' }),
} as any
xrpl.validate(vaultCreate)
const r = await client.submitAndWait(vaultCreate, { wallet: broker, autofill: true })
// vaultID = CreatedNode Vault LedgerIndex ; shareMPTID = vault_info(vaultID).vault.ShareMPTID
```

Pièges : `Flags` doit rester à `0` (pas de `tfVaultPrivate`, pas de `tfVaultShareNonTransferable`). Si `temMALFORMED` → vérifier le gap ; si `tecEXPIRED` → dates déjà passées (horloge du ledger ≠ horloge locale, ajouter marge).

Lire l'état : `await client.request({ command: 'vault_info', vault_id: vaultID })` → `AssetsTotal`, `AssetsAvailable`, `LossUnrealized`, `ShareMPTID`, `shares.OutstandingAmount`, et (V1.1) `VaultKind`, `SubscriptionDate`, `RedemptionDate`.

### Étape 3 — Dépôt d'Alice pendant Subscription (Minimum bar #2) (10 min)

```ts
{ TransactionType: 'VaultDeposit', Account: alice.address, VaultID: vaultID,
  Amount: { mpt_issuance_id: usdxId, value: '10000' } }
```

Alice reçoit des parts `SWF1` (MPToken créé automatiquement). Vérifier via `account_objects { account: alice, type: 'mptoken' }`. **Test négatif bonus** : refaire un `VaultDeposit` après `SubscriptionDate` → `tecEXPIRED` (à consigner).

### Étape 4 — LoanBroker + First-Loss Capital (Minimum bar #3a) (15 min)

```ts
{ TransactionType: 'LoanBrokerSet', Account: broker.address, VaultID: vaultID,
  ManagementFeeRate: 500,        // 0,5 %
  DebtMaximum: '8000',
  CoverRateMinimum: 10000,       // 10 % de DebtTotal doit être couvert
  CoverRateLiquidation: 5000 }   // 5 % du cover min mobilisé par défaut
// loanBrokerID = CreatedNode LoanBroker LedgerIndex

{ TransactionType: 'LoanBrokerCoverDeposit', Account: broker.address, LoanBrokerID: loanBrokerID,
  Amount: { mpt_issuance_id: usdxId, value: '1500' } }
```

Lecture : `ledger_entry { loan_broker: loanBrokerID }` → `DebtTotal`, `CoverAvailable`, `OwnerCount`, `LoanSequence`.

### Étape 5 — Attendre la phase Investment, puis LoanSet co-signé (Minimum bar #3b + #4 drawdown) (30 min)

Attendre `ledger close_time > SubscriptionDate` (poller `vault_info` ou `ledger` `close_time`).

Le prêt doit finir **≥ 60 s avant `RedemptionDate`** : avec `red − sub = 300 s`, prendre `PaymentTotal: 2`, `PaymentInterval: 60` (fin à StartDate + 120 s).

```ts
console.warn = () => {}   // le tutoriel officiel le fait : autofill de LoanSet émet un warning parasite
const loanSetTx = await client.autofill({
  TransactionType: 'LoanSet', Account: broker.address, Counterparty: borrower.address,
  LoanBrokerID: loanBrokerID, PrincipalRequested: '5000',
  InterestRate: 1200,            // 1,2 % annualisé (1/10 bps)
  PaymentTotal: 2, PaymentInterval: 60, GracePeriod: 60,
  LoanOriginationFee: '50', LoanServiceFee: '5',
})
const brokerSigned = xrpl.decode(broker.sign(loanSetTx).tx_blob)                 // 1. broker signe
const fully = xrpl.signLoanSetByCounterparty(borrower, brokerSigned)             // 2. borrower contre-signe
xrpl.validate(fully.tx)
const res = await client.submit(fully.tx_blob)                                   // 3. soumettre le blob
// loanID = CreatedNode Loan LedgerIndex ; le principal (5000 − 50 de fee) est transféré au borrower = drawdown
```

Codes attendus si mal placé : `tecTOO_SOON` (encore en Subscription), `tecEXPIRED` (déjà en Redemption), `tecNO_PERMISSION` (échéancier dépasse `RedemptionDate − 60 s`), `tecLIMIT_EXCEEDED` (`DebtMaximum` ou cover insuffisant), `tecINSUFFICIENT_FUNDS` (`AssetsAvailable` trop bas).

Lecture : `ledger_entry { loan: { loan_broker_id, loan_seq } }` → `PrincipalOutstanding`, `TotalValueOutstanding`, `PeriodicPayment`, `NextPaymentDueDate`, `PaymentRemaining`, `Flags`.

### Étape 6 — Remboursement LoanPay (Minimum bar #5) (10 min)

```ts
{ TransactionType: 'LoanPay', Account: borrower.address, LoanID: loanID,
  Amount: { mpt_issuance_id: usdxId, value: loan.PeriodicPayment } }
```

Répéter ou laisser une échéance impayée pour la démo RiskLens (`LoanManage` + `tfLoanImpair` par le broker → `lsfLoanImpaired`, `LossUnrealized` du vault augmente).

### Étape 7 — Garde-fou : retrait anticipé rejeté (Minimum bar #6) (10 min)

Pendant Investment :

```ts
{ TransactionType: 'VaultWithdraw', Account: alice.address, VaultID: vaultID,
  Amount: { mpt_issuance_id: shareMPTID, value: '10000' } }   // → meta.TransactionResult === 'tecTOO_SOON'
```

Capturer `hash`, `TransactionResult`, `ledger_index`. C'est **la** transaction à montrer au jury et à mettre dans le feedback (lisibilité de `tecTOO_SOON`).

### Étape 8 — SecondWave : « Exit the Wave » / « Catch the Wave » (Minimum bar #7) (1 h 30)

1. **Bob s'autorise sur les parts** : `{ TransactionType: 'MPTokenAuthorize', Account: bob.address, MPTokenIssuanceID: shareMPTID }`.
2. **Pricing off-chain** (engine) : `discount` choisi par Alice → `price = shares × NAV × (1 − discount)`, `Implied APY` affiché à Bob (§4).
3. **Règlement atomique** :

```ts
const sharesLeg = { TransactionType: 'Payment', Account: alice.address, Destination: bob.address,
  Amount: { mpt_issuance_id: shareMPTID, value: '10000' }, Flags: xrpl.GlobalFlags.tfInnerBatchTxn }
const cashLeg   = { TransactionType: 'Payment', Account: bob.address,   Destination: alice.address,
  Amount: { mpt_issuance_id: usdxId,     value: '9700' },  Flags: xrpl.GlobalFlags.tfInnerBatchTxn }
// tfInnerBatchTxn = 0x40000000 vit dans xrpl.GlobalFlags (pas PaymentFlags) ; autofill(batch, 2) ajoute Fee '0' et SigningPubKey ''
const batch = { TransactionType: 'Batch', Account: orchestrator.address,
  Flags: xrpl.BatchFlags.tfAllOrNothing, RawTransactions: [{ RawTransaction: sharesLeg }, { RawTransaction: cashLeg }] }
xrpl.validate(batch)
const filled = await client.autofill(batch, 2)          // 2 = nb de BatchSigners attendus
xrpl.signMultiBatch(alice, filled)
xrpl.signMultiBatch(bob, filled)
const combined = xrpl.combineBatchSigners([filled /* alice */, filledBobCopy /* bob */])
await client.submitAndWait(combined, { wallet: orchestrator })
```

> Note d'implémentation : `signMultiBatch` mute l'objet ; cloner `filled` avant chaque signature puis passer les deux copies à `combineBatchSigners`. En cas de `temINVALID_INNER_BATCH`, vérifier `Fee: '0'`, `SigningPubKey: ''` et le flag `tfInnerBatchTxn` sur les inner.

Résultat : Alice a du cash immédiatement, Bob détient les parts. Vérifier les soldes via `account_objects type mptoken`.

### Étape 9 — Après RedemptionDate : Bob retire (Minimum bar #8) (10 min)

Attendre `close_time ≥ RedemptionDate`, puis :

```ts
{ TransactionType: 'VaultWithdraw', Account: bob.address, VaultID: vaultID,
  Amount: { mpt_issuance_id: shareMPTID, value: '10000' } }   // → tesSUCCESS
```

Bob reçoit `shares × (AssetsTotal − LossUnrealized) / SharesTotal` en USDX. Comparer au prix payé → rendement réalisé.

### Étape 10 — Indexeur + RiskLens (2 h)

- Snapshots toutes les 5 s : `vault_info`, `ledger_entry loan_broker`, chaque `loan` via `LoanSequence` 1..N, `account_tx` du pseudo-compte du broker pour l'historique (les `Loan` disparaissent au `LoanDelete`).
- Tables : `vault_snapshot`, `broker_snapshot`, `loan_snapshot`, `loan_events` (Set/Pay/Impair/Default/Delete).
- Score (0–100) avec les poids du plan v1 :
  `FLCR = CoverAvailable / max(DebtTotal, ε)` · `NPL = prêts impaired|default / prêts émis` · `Concentration = max(PrincipalOutstanding) / DebtTotal` · `Liquidité = AssetsAvailable / AssetsTotal` · `DID` = 1 si le broker a une Credential acceptée (`account_objects type credential`), sinon 0.
  `RiskScore = 35·FLCR' + 25·(1−NPL) + 20·(1−Conc) + 10·Liq + 10·DID` puis grille AAA ≥ 85 … D < 5.
- Stress-test : `DefaultCovered = min(CoverRateMinimum/100000 × DebtTotal × CoverRateLiquidation/100000, DefaultAmount, CoverAvailable)` ; perte résiduelle → `LossUnrealized` simulé → NAV par part → impact sur l'Implied APY de chaque offre.

### Étape 11 — Frontend Next.js (3 h)

- `/market` : offres (parts, décote, prix, Implied APY, note du courtier), bouton **Catch the Wave** → construit le `Batch`, demande les deux signatures (démo : seeds locaux ; prod : Xaman/Crossmark via XLS-56 multi-sign).
- `/exit` : Alice choisit ses parts + décote, voit le cash net et l'APY implicite cédé.
- `/broker/[id]` : fiche RiskLens (jauge AAA→D, FLCR, NPL, concentration, liquidité, DID, historique).
- `/simulate` : sliders défaut % → courbe NAV / First-Loss / perte déposants.
- `/demo` : timeline live des 9 étapes avec hash + code de résultat (`tecTOO_SOON` en rouge, `tesSUCCESS` en vert).

### Étape 12 — Rapport DevX `FEEDBACK_XLS65_XLS66.md` (au fil de l'eau, 1 h de mise en forme)

Points déjà établis à documenter (Contexte / Issue / Impact / Preuve / Suggestion) :

1. **xrpl.org n'expose pas V1.1** : `VaultCreate` doc sans `VaultKind/SubscriptionDate/RedemptionDate`, `Vault` sans phases ; il a fallu lire `rippled/Protocol.h` et `VaultHelpers.cpp`. Suggestion : page « Closed-ended vaults » + tableau des phases et codes.
2. **`xrpl.js` 5.2.0 : codec OK, types KO** — `VaultCreate` TS n'a pas les 3 champs, `LoanSet` n'a pas `Borrower/LoanID/tfLoanSetAccept` (flux 2 étapes V1.1). Cast `as any` obligatoire.
3. **Pas de DEX pour les parts MPT** (`MPTokensV2` absent de Devnet) — la marketplace doit passer par `Batch`. Suggestion : activer XLS-82 sur Devnet ou documenter le pattern Batch pour le marché secondaire.
4. **Sémantique des codes** : `tecTOO_SOON` (withdraw en Investment) vs `tecEXPIRED` (deposit en Investment) — un dépôt « trop tard » renvoie « expiré », cohérent mais peu lisible côté wallet.
5. **`LoanSet` rejeté `tecNO_PERMISSION`** quand l'échéancier dépasse `RedemptionDate − 60 s` : le code ne dit rien du problème de dates. Suggestion : `tecLOAN_SCHEDULE_TOO_LONG` ou message dans `engine_result_message`.
6. **Le tutoriel officiel neutralise `console.warn`** pendant `autofill(LoanSet)` — symptôme d'un warning parasite dans la lib.
7. **Owner = Broker imposé** (`LoanBrokerSet` par `Vault.Owner`) : la séparation gestionnaire de coffre / courtier n'est pas possible, à expliciter dans la doc concepts.
8. À compléter pendant le build : frictions `Batch` (`temINVALID_INNER_BATCH`), `MPTokenAuthorize` oublié (`tecNO_AUTH`), arrondis `tecPRECISION_LOSS`, `Scale` fixé à 0 pour les MPT.

Chaque fiche cite le hash Devnet et le lien explorer `https://devnet.xrpl.org/transactions/<hash>`.

---

## 4. Formules (rappel, implémentées dans `packages/engine`)

- **NAV par part** : `(AssetsTotal − LossUnrealized) / shares.OutstandingAmount`
- **Valeur à maturité estimée** : `NAV_now × parts + part_du_déposant × (intérêts restants − ManagementFeeRate × intérêts)`
- **Implied APY** : `((valeur_maturité / prix_payé) − 1) × 365 / jours_restants`, `jours_restants = (RedemptionDate − now) / 86400`
- **Rachat** : `Δassets = Δshares × (AssetsTotal − LossUnrealized) / SharesTotal`
- **First-loss** : `DefaultCovered = min(CoverMin × CoverRateLiquidation, DefaultAmount, CoverAvailable)` avec `CoverMin = DebtTotal × CoverRateMinimum / 100000`

---

## 5. Ordre d'exécution & répartition (2 personnes, ~10 h)

| Bloc | Qui | Durée | Sortie |
|---|---|---|---|
| Étapes 0–4 | Chain | 1 h 30 | `state.json` avec IDs, USDX, vault fermé, broker |
| Étapes 5–7 | Chain | 1 h | loan, LoanPay, **hash `tecTOO_SOON`** |
| Engine + tests | Front/Engine | 1 h | formules validées |
| Étape 8 (Batch) | Chain | 1 h 30 | swap atomique sur Devnet |
| Étape 9 | Chain | 15 min | withdraw Bob `tesSUCCESS` |
| Étape 10 indexer | Chain | 2 h | SQLite + score |
| Étape 11 front | Front | 3 h | 5 pages |
| Étape 12 feedback | Les deux | continu + 1 h | `FEEDBACK_XLS65_XLS66.md` |
| Script `demo:run` | Chain | 30 min | rejoue les 9 étapes en < 10 min avec pauses sur les phases |

---

## 6. Risques & plans B

| Risque | Détection | Plan B |
|---|---|---|
| Horloge ledger vs locale → `tecEXPIRED` à la création | premier `VaultCreate` | prendre `close_time` du dernier ledger validé comme base au lieu de `Date.now()` |
| `Batch` multi-comptes échoue (`temINVALID_INNER_BATCH`) | étape 8 | fallback : 2 `EscrowCreate` MPT croisés (TokenEscrow activé, parts `CanEscrow`) avec `FinishAfter`, ou Payment séquentiel avec l'orchestrateur en dépositaire |
| Devnet reset pendant le hackathon | `account_info` → `actNotFound` | `demo:run` recrée tout en 5 min depuis zéro |
| `xrpl.validate` rejette `VaultKind` dans une future version | CI | garder un `encode()` de contrôle et un test de non-régression |
| Faucet rate-limit | `fundWallet` 429 | pré-financer 6 comptes, réutiliser les seeds |
