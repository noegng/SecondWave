# BUILD — la couche vault SecondWave

De l'exploration (`probes/RESULTATS.md`, 220 cas sur le Devnet) au socle
opérationnel. Ce document relie chaque règle encodée au cas qui l'a établie.

## Ce qui a été construit

| Module | Rôle | Nouveautés de ce build |
|---|---|---|
| `packages/vault/src/rules.mjs` | **les règles XLS-65/66 + leurs unités** | `VaultError` (code · message factuel · remède) et un validateur par règle, **purs, hors réseau** |
| `packages/vault/src/index.mjs` | cycle de vie | chaque helper **valide avant d'envoyer** ; ajout de `updateBroker`, `deleteLoan`, `payLoan(…, flags)` |
| `packages/core/src/analytics.mjs` | **dérivations pour l'analyste** | `phaseInfo`, `vaultMetrics`, `brokerMetrics`, `loanMetrics`, `concentrationHHI` — entiers en `string` |
| `packages/core/src/index.mjs` | lecture | `readVaultGraph` enrichi (`.metrics` vault + par broker + par prêt) ; `holderMap` + `hhi` ; **signatures existantes intactes** |
| `fixtures/generate.mjs` | générateur de monde v2 | 7 profils de risque + `snapshot.json` (dump hors ligne) |
| `packages/analyst/CONTRAT.md` + `run.mjs` + `EXPECTED.json` | contrat de Noé | forme des données, signaux à détecter, runner offline, cas attendus |
| `packages/*/test/*.test.mjs` | tests hors ligne | 26 cas — une règle, un cas passant, un cas refusé, le message |

## Comment on lance

```bash
npm test                         # règles + dérivations, HORS LIGNE (26 cas)
npm run world                    # (Devnet) régénère world.json + state.json + snapshot.json
npm run analyse -- predateur     # HORS LIGNE : analyse un vault du snapshot
npm run analyse                  # liste les vaults du snapshot
npm run test:integration         # (Devnet, ~5 min) rejoue un cycle complet
node fixtures/test-settlement.mjs  # (Devnet) vérifie que le socle porte encore settlement
```

Pour Noé : **`npm run analyse -- <clé>` suffit** — pas de Devnet, pas de faucet,
pas d'attente de phase. Il code le corps de `analyse()` dans
`packages/analyst/src/index.mjs` et compare à `EXPECTED.json`.

## Les règles non documentées désormais encodées

Chacune est validée **localement, avant le réseau**, avec un message qui nomme le
champ et donne le remède — là où le protocole répond `temMALFORMED`/`temINVALID`
nu. Renvoi = cas de `probes/RESULTATS.md`.

| Règle encodée | Validateur | Sortie brute du protocole | Cas |
|---|---|---|---|
| **60 ≤ GracePeriod ≤ PaymentInterval** (⇒ interval ≥ 60) | `assertLoanSchedule` | `temINVALID` nu | §F (g-sweep) |
| écart RedemptionDate−SubscriptionDate ∈ [180, ~30 ans) | `assertVaultDates` | `temMALFORMED` nu (serveur) | A-5/6/7, X6 |
| closed-ended ⇒ les deux dates obligatoires | `assertVaultDates` | `temMALFORMED` (serveur) | A-2/3 |
| dernière échéance ≤ RedemptionDate − ~90 s (temps ledger) | `assertLoanEndsBeforeRedemption` | `tecNO_PERMISSION` | F-69, X2 |
| `Scale` interdit sur XRP/MPT, ∈ [0,18] sur IOU | `assertScale` | `temMALFORMED` nu | A-8/9/10 |
| `CoverRateMinimum`/`CoverRateLiquidation` : les deux nuls ou non nuls | `assertCoverRates` | `temMALFORMED` (serveur) | E-51/52 |
| `CoverRate*` et `ManagementFeeRate` **immuables** après création | `assertBrokerUpdateAllowed` | `temINVALID` nu | X1, Y2 |
| `ManagementFeeRate` ∈ [0, 10000] | `assertManagementFee` | `temINVALID` nu (serveur) | E-59 |
| `StartDate` interdit sur LoanSet | `assertNoForbiddenLoanFields` | `invalidTransaction` (local check) | F-74 |
| `Data` sur LoanSet : accepté puis **jeté** → on refuse en amont | `assertNoForbiddenLoanFields` | `tesSUCCESS` puis champ absent | F-75 |
| `WithdrawalPolicy` : seule la valeur 1 existe | `assertWithdrawalPolicy` | `temMALFORMED` | A-12 |
| `Data` : hex pair, 1..256 octets | `assertDataHex` | messages divers | A-13 |
| `DomainID` impose `tfVaultPrivate` | `assertDomainFlag` | `temMALFORMED` (serveur) | A-17 |
| `InterestRate` : entier borné (2³²−1 échoue) | `assertInterestRate` | `temINVALID` | F-72 |

### Les unités, introuvables dans toute doc (constantes commentées dans `rules.mjs`)

- `InterestRate` : **annualisé, en 1/100 000** (5 %/an = 5000). `interestOver()`. [F-72]
- `CoverRate*` et `ManagementFeeRate` : **1/100 000** (10 % = 10000). [E-55/59]
- Ponction du cover au défaut : `principal × min × liq / 1e5²` — **pas** `min(cover, perte)` :
  aux taux par défaut, la protection réelle n'est que de **5 % du principal**. `coverPayoutAtDefault()`. [G-85]
- Cover exigé : `dette × CoverRateMinimum / 1e5`. `coverRequired()`. [E-55]

### Ce que `core` dérive pour l'analyste (calculs absents de la chaîne)

- **`loan.metrics.defaillable`** = `now > NextPaymentDueDate + GracePeriod` sans flag de défaut —
  rien on-ledger ne le dit. [G-89]
- **`loan.metrics.selfLoan`** = borrower === broker owner (auto-prêt). [J-111]
- `metrics.navPrudentPerShare` = `(AssetsTotal − LossUnrealized) / parts` — `AssetsTotal` ne
  bouge pas à l'impairment. [G-83]
- `broker.metrics.coverWithdrawable` — 100 % à `DebtTotal = 0`. [E-57]
- `holders.hhi` (Herfindahl) en plus de la concentration simple.

## Garanties de compatibilité

- Aucune signature exportée de `core` n'a été retirée ni renommée ; tout est additif.
- `settlement`, `orderbook`, `apps/cli`, `analyst` (placeholder) chargent et tournent —
  vérifié par import et par `node fixtures/test-settlement.mjs`.
- `xrpl.js@5.2.0-beta.1` (LendingProtocolV1_1) ; le contournement `counterpartySign` (`CPT\0`) intact.
