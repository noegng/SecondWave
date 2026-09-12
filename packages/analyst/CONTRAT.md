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

## 1. La signature (déjà figée dans `src/index.mjs`)

```js
export function analyse({ graph, holders, order = null }) → Note
```

```
graph    ← core.readVaultGraph(vaultId)      (dans snapshot.json : vaults[clé].graph)
holders  ← core.holderMap(graph.vault)       (dans snapshot.json : vaults[clé].holders)
order    ← une offre du carnet, ou null pour une analyse de vault seule
           { id, vaultId, seller, shares, price, expiry }
```

```
Note = {
  score:     0-100,                      // plus haut = plus sûr
  verdict:   'sain' | 'prudence' | 'risqué' | 'à fuir',
  nav:       string,                     // valeur d'une part, en drops (×1e6)
  fairPrice: string | null,              // ce que l'offre devrait valoir, ou null
  signaux:   [{ niveau, titre, detail }] // niveau : 'info' | 'alerte' | 'rouge'
}
```

**Règle d'or** : tu ne lis jamais un objet ledger brut ni ne calcules une date
Ripple. Tout est pré-dérivé dans `graph.metrics`, `broker.metrics`, `loan.metrics`
et `holders`. Les grands entiers sont des **strings** (drops, parts) ; les ratios
sont des **numbers** (0..1). Passe les strings par `BigInt(...)` si tu calcules.

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
    "navScaled": "1000000", "navPerShare": 1,           // valeur d'une part (×1e6 / décimal)
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

`nav` et `fairPrice` : `nav = graph.metrics.navScaled` (ou `navPrudentScaled` pour
être prudent). `fairPrice` d'une offre ≈ `navPrudentScaled × order.shares / 1e6`,
décoté par le risque (ton score). Une part non transférable ⇒ `fairPrice = null`.

---

## 4. Le runner

`npm run analyse -- <clé>` charge `snapshot.json`, imprime les **faits dérivés**
(ta matière première) puis le résultat de `analyse()`. Aucun réseau. Itère
dessus : modifie `src/index.mjs`, relance, compare aux cas attendus ci-dessous.

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
