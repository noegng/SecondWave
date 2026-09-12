# Contrat de l'analyste — @secondwave/analyst

**Le seul document que Noé doit lire.** Tout ce qui suit est déjà en place :
`core` te livre les données mâchées, `snapshot.json` te permet de travailler hors
ligne, le runner appelle ta fonction. **Tu n'écris qu'une chose : le corps de
`analyse()`.**

Démarrage en une commande, sans réseau :

```bash
npm run analyse -- predateur     # analyse un vault du snapshot
npm run analyse                  # liste les vaults disponibles
```

---

## 1. L'API réellement implémentée (Noé) et le pont depuis core

L'analyste travaille **par broker / par offre** sur un modèle **normalisé** (champs
camelCase), pas sur l'objet ledger brut :

```js
scoreBroker({ broker, vault, loans, nowRipple }) → { riskScore, rating, … }
ratingFromScore(riskScore) → 'AAA' | 'AA' | 'A' | 'B' | … | 'D'
analyzeOffer({ vault, broker, loans, offer, nowRipple, stressRate }) → { phase, nav, score, yield, classification, stress }
```

**Modèle normalisé attendu** (cf. `test/fixtures.mjs`) :

```
vault  { vaultId, assetsTotal, assetsAvailable, lossUnrealized, sharesOutstanding,
         vaultKind, subscriptionDate, redemptionDate }
broker { loanBrokerId, vaultId, debtTotal, coverAvailable, coverRateMinimum,
         coverRateLiquidation, managementFeeRate, didVerified }
loan   { loanId, principalOutstanding, totalValueOutstanding, managementFeeOutstanding,
         nextPaymentDueDate, gracePeriod, flags }
```

**Le pont core → analyste** est fait par `toAnalystInput(graph)` dans
`src/run.mjs` : il mappe `core.readVaultGraph()` (brut + `.metrics`) vers ce modèle.
Lance `npm run analyse -- <clé>` : ça charge `snapshot.json`, imprime les faits
dérivés par core **et** la note de ton analyste, entièrement **hors ligne**.

> Les grands entiers restent des **strings** (drops, parts) tout au long — `num()`
> de ton `num.mjs` les convertit. Les ratios de `graph.metrics` sont des `number`.

Ci-dessous, la forme des données **telles que core les livre** (dans
`snapshot.json`), pour référence : c'est la source du pont ci-dessus.

---

## 2. La forme exacte de `graph` et `holders`

### `graph` (extrait réel de `snapshot.json`, vault `predateur`)

```jsonc
{
  "vaultId": "…", "at": "8425…",
  "vault":  { …objet ledger brut, si jamais tu en as besoin… },
  "shares": { "MPTokenIssuanceID": "…", "OutstandingAmount": "50000000", "Flags": 60 },
  "phase":  "Investment",                        // compat ; préférer metrics.phase

  "metrics": {                                   // ⭐ LE niveau vault, tout mâché
    "assetsTotal": "50000000", "assetsAvailable": "28000000", "assetsLent": "22000000",
    "lossUnrealized": "0", "outstandingShares": "50000000",
    "navScaled": "1000000", "navPerShare": 1,           // NAV/part au pair (×1e6 / décimal)
    "navPrudentScaled": "1000000", "navPrudentPerShare": 1,   // (assets − pertes) / parts
    "utilisation": 0.44, "lossRatio": 0,               // 0..1
    "phase": "Investment", "next": "Redemption",
    "subscriptionDate": "…", "redemptionDate": "…",
    "endsAt": "…", "secondsRemaining": "…",
    "brokerCount": 1, "loanCount": 1,
    "hasUncoveredBroker": true,    // au moins un broker 0/0
    "hasSelfLoan": true,           // au moins un auto-prêt
    "hasUndeclaredDefault": true,  // au moins un prêt défaillable non déclaré
    "shareNonTransferable": false, // parts sans marché secondaire
    "isIou": false, "assetIssuer": null
  },

  "brokers": [{
    …objet LoanBroker brut…,
    "metrics": {                                 // ⭐ par broker
      "owner": "r…",
      "coverAvailable": "0", "debtTotal": "22000000", "debtMaximum": "45000000",
      "coverRateMinimum": 0, "coverRateLiquidation": 0,
      "coverRateMinimumPct": 0, "coverRateLiquidationPct": 0,
      "noCover": true,                           // 🔴 aucun first-loss capital
      "coverRequired": "0",
      "coverWithdrawable": "0", "coverWithdrawableIsEstimate": true,
      "debtRatio": 0.48, "coverFractionOfDebt": 0
    },
    "loans": [{
      …objet Loan brut…,
      "metrics": {                               // ⭐ par prêt
        "borrower": "r…", "selfLoan": true,      // 🔴 borrower === broker.owner
        "principalOutstanding": "22000000", "totalValueOutstanding": "22000030",
        "nextPaymentDueDate": "…", "gracePeriod": "60", "paymentRemaining": "3",
        "secondsLate": "40", "status": "défaillable", "defaillable": true,
        "impaired": false, "defaulted": false, "overpayment": false,
        "weight": 0.44                           // principal / AssetsTotal
      }
    }]
  }]
}
```

`status` d'un prêt ∈ `sain` · `en grâce` · `défaillable` · `impairé` · `en défaut` · `soldé`.
(Le brief cite « en retard » : c'est `en grâce` — passé l'échéance mais encore
curable ; au-delà de la grâce c'est `défaillable`.)

### `holders`

```jsonc
{
  "count": 3, "concentration": 0.55,   // part du plus gros détenteur (0..1)
  "hhi": 3450,                          // Herfindahl 0..10000 (>2500 = concentré)
  "reconciles": true,                   // le rejeu account_tx retombe sur OutstandingAmount
  "totalStr": "50000000", "outstandingStr": "50000000",
  "holders": [{ "account": "r…", "shares": "27500000" }, …]  // triés décroissant
}
```

---

## 3. Les signaux à détecter — cas déclencheur + raison métier

| Signal | Où le lire | Cas du monde | Pourquoi c'est grave |
|---|---|---|---|
| **cover à zéro** | `broker.metrics.noCover` | `predateur` | aucun first-loss : au défaut, la perte tombe à 100 % sur les déposants [G-86] |
| **auto-prêt** | `loan.metrics.selfLoan` / `metrics.hasSelfLoan` | `predateur` | le gérant s'emprunte à lui-même via son propre broker 0/0 — recette de rug-pull [J-111] |
| **défaillable non déclaré** | `loan.metrics.defaillable` / `hasUndeclaredDefault` | `sain`(2e prêt), `predateur` | échéance+grâce dépassées sans défaut déclaré ; invisible sans le calcul [G-89] |
| **cover retirable** | `broker.metrics.coverWithdrawable` (surtout à `debtTotal:"0"`) | `sain` après remboursements | à dette nulle le broker retire 100 % : la garantie affichée n'engage rien demain [E-57] |
| **concentration** | `holders.concentration`, `holders.hhi` | `predateur`, `verrouille` | un déposant majoritaire peut inonder le carnet ; HHI > 2500 = risque de liquidité |
| **perte latente** | `metrics.lossRatio` > 0, `loan.metrics.impaired` | `deprecie` | NAV nominale trompeuse ; comparer `navPerShare` vs `navPrudentPerShare` [G-83] |
| **échéance vs Redemption** | `loan.metrics.nextPaymentDueDate` proche de `metrics.redemptionDate` | tout prêt tardif | aucune marge de recouvrement avant la fin du vault [F-69] |
| **parts non transférables** | `metrics.shareNonTransferable` | `verrouille` | aucune sortie par le marché secondaire : la seule issue est la Redemption |
| **clawback armé** | `metrics.isIou` && `meta.clawbackArmed` (dans `snapshot.vaults[clé].meta`) | `iou` | l'émetteur de l'actif peut saisir la position d'un déposant [I-102] |
| **rejeu divergent** | `holders.reconciles === false` | (aucun en conditions saines) | lecture incomplète : ne pas noter à l'aveugle |

`nav` et les prix : `nav = graph.metrics.navScaled`, **×1e6 avec 1e6 = pair**. Le
facteur est `10^Scale` et non 1e6 en dur, sinon un vault IOU `Scale 6` au pair
sort à 1 là où un vault XRP au pair sort à 1e6 — les deux NAV ne seraient pas
comparables.

`analyse()` renvoie deux prix, pour ne pas changer d'unité selon les arguments :

- `fairPricePerShare` — prix par part, même échelle que `nav` (×1e6). Toujours
  présent, `null` si les parts ne sont pas transférables.
- `fairPrice` — **total** pour `order.shares`, décoté par le score. `null` si
  aucun `order` n'est fourni : un appelant qui compare au prix demandé d'une
  offre doit passer `order`, sinon il comparerait un prix par part à un total.

---

## 4. Le runner

`analyse({ graph, holders, order, meta })` est implémentée. Le runner :

```bash
npm run analyse -- <clé>        # snapshot.json, hors ligne
npm run analyse -- all
npm run analyse -- live         # relit world.json sur le Devnet
npm run analyse -- vault <id>   # n'importe quel vault_id (public inclus)
npm run analyse -- scan         # ledger_data type=vault
```

---

## 5. Cas attendus (cible + non-régression)

Machine-lisible : `packages/analyst/EXPECTED.json`. En clair :

| Vault | Verdict cible | Signaux rouges attendus | Signaux d'alerte attendus |
|---|---|---|---|
| `sain` | `prudence` | défaillable non déclaré (2e prêt) | cover retirable (après paiements) |
| `predateur` | `à fuir` | cover 0/0, auto-prêt, défaillable non déclaré | concentration |
| `deprecie` | `prudence`/`risqué` | — | perte latente (prêt impairé) |
| `iou` | `risqué` | clawback armé, défaillable non déclaré | — |
| `verrouille` | `prudence` | — | parts non transférables (fairPrice = null) |
| `redemption` | `sain` | — | — (phase Redemption, sortie ouverte) |
| `solde` | `sain` | — | — (prêt soldé et supprimé) |

Ces cibles sont indicatives (la pondération exacte du score t'appartient) ;
ce qui ne doit PAS bouger : **la présence des signaux rouges** listés. Un
`predateur` sans le rouge « auto-prêt » est une régression.
