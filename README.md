# SecondWave

Marché secondaire de positions de vault privé sur XRPL, avec analyste de risque intégré.
**XRPL Lending Protocol Hackathon** — track XLS-65 (Single Asset Vault) + XLS-66 (Lending Protocol).

---

## Le problème

Un vault *closed-ended* **enferme le capital**. Pendant toute la phase Investment, `VaultWithdraw` renvoie `tecTOO_SOON` — le déposant ne peut pas sortir.

Pendant cet enfermement, le risque peut empirer **sans que le prix affiché ne bouge** : `AssetsTotal` ne change qu'au moment où le broker déclare un impairment ou un défaut. Un prêt défaillable depuis des heures laisse la NAV intacte.

**Faits mesurés sur le Devnet :**
- un défaut socialise **95 %** de la perte sur les déposants — le cover du broker est plafonné à `DebtTotal × CoverRateMinimum × CoverRateLiquidation`, **pas** à ce qu'il détient
- le broker peut retirer **100 %** de son first-loss capital quand `DebtTotal = 0`
- sur un vault en IOU, l'**émetteur de l'actif** peut saisir la position d'un déposant

## La solution

Les parts de vault sont des **MPT transférables**. Un **Batch atomique à trois jambes** permet de vendre sa position sans escrow, sans oracle, sans contrat et sans confiance.

Et un **analyste** ferme l'asymétrie : il lit le ledger et distingue une **décote de liquidité** (opportunité) d'une **décote de détresse** (piège).

---

## Arborescence

```
packages/
  core/        lecture du ledger, definitions custom, types partagés   ← contrat d'interface
  vault/       création, dépôts, parts, brokers, prêts
  settlement/  preflight · batch 3 jambes · evidence · réconciliation
  orderbook/   offres, appariement
  analyst/     métriques de risque, scoring, rendement implicite
apps/
  cli/         démo terminal
fixtures/      générateur de monde de démo
```

## Répartition

| Qui | Quoi |
|---|---|
| **Hugo** | `core`, `vault`, `settlement`, `orderbook`, `fixtures` |
| **Noé** | `analyst` |

**Règle git :** ce dont on dépend tous les deux va sur `main` vite (`core` en premier). Le reste sur sa branche, avec des merges fréquents. Pas de branche qui vit 36 h.

---

## Démarrage

```bash
npm install
npm test              # moteur + adapter analyst (pas besoin du Devnet)
npm run analyst       # rapport des 3 scénarios (A sain / B spéculatif / C crise)
npm run analyse -- all          # les 7 vaults de snapshot.json (hors ligne)
npm run analyse -- live         # relit world.json sur le Devnet
npm run analyse -- scan         # découvre les vaults publics du ledger
npm run world         # génère l'écosystème de démo sur le Devnet (Hugo)
npm run cli
```

### Analyst (Noé)

| Fait | Suite |
|---|---|
| Moteur pur (score, NAV, APY, cover, stress, liquidité vs détresse) | **fait** |
| Adapter `vault_info` / `ledger_entry` → snapshots | **fait** — `adaptVault`, `adaptBroker`, `adaptLoan` |
| Rapport CLI 3 scénarios | **fait** — `npm run analyst` |
| Brancher `world.json` / `snapshot.json` | **fait** — `npm run analyse -- all` |
| Lecture live Devnet + vaults publics | **fait** — `live` / `vault` / `scan` |
| Historique (Loan disparaît au `LoanDelete`) | après le dump : timeline via `account_tx` |
| Fiche DevX jury (first-loss ≠ CoverAvailable) | **fait** — [FEEDBACK_XLS65_XLS66.md](./FEEDBACK_XLS65_XLS66.md) |

Point d'entrée : `analyzeOffer(adaptCase(rawLedgerJson))`.

## Réseau

**Devnet standard** — le « Lending-Devnet » de la doc **n'existe plus** (NXDOMAIN).

| | |
|---|---|
| WebSocket | `wss://s.devnet.rippletest.net:51233` |
| Faucet | `https://faucet.devnet.rippletest.net/accounts` |
| Build | `3.4.0-rc2` · `network_id` 2 |

---

## ⚠️ Pièges à connaître avant de coder

- **`ripple-binary-codec` ignore les champs V1_1** (`VaultKind`, `SubscriptionDate`, `RedemptionDate`) → charger des **definitions custom** depuis `server_definitions`. `Wallet.sign()` et `submitAndWait()` ne les acceptent pas → signature et soumission manuelles.
- **`LoanSet` est cassé dans les SDK publiés.** `fixCleanup3_4_0` attend le préfixe `CPT\0` (`43505400`) pour la co-signature, `CPM\0` (`43504D00`) en multisig — xrpl.js et xrpl-py signent avec `STX\0`. Le fix tient en trois lignes.
- **Un Batch renvoie `tesSUCCESS` même quand ses jambes échouent**, et sa meta ne contient aucun `BatchExecutions`. **Toujours vérifier par les soldes.**
- **`NetworkID` doit être omis** (network_id ≤ 1024).
- Un code `tec` **consomme la séquence** → lire `account_info` avec `ledger_index:'current'`.
- L'acheteur doit faire **`MPTokenAuthorize` avant** de recevoir des parts → première jambe du batch.
- **Il n'existe ni `loan_info`, ni `loan_broker_info`, ni `mpt_holders`.** Traversée : `vault_info` → `account_objects` du pseudo-compte du vault → `account_objects` de chaque pseudo-broker. Et `account_tx` sur le pseudo-compte voit **tous** les mouvements de parts.

---

## XRPL DevEx Capture

L'outil de l'organisateur est **gitignoré** — chacun l'installe chez soi :

```bash
git clone https://github.com/RippleDevRel/xrpl-devex-hook.git
TEAM_NAME="SecondWave" CONSENT=yes INVITE_CODE="<code>" \
  node xrpl-devex-hook/hook/setup.mjs --non-interactive --agent claude-code
```

Puis `/hooks` dans Claude Code pour approuver, et relancer la session.
`/xrpl-feedback <texte>` et `/xrpl-session-analysis` sont disponibles.
