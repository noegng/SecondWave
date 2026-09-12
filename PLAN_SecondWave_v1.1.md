# Plan Hackathon : SecondWave (Track 2 — Closed-Ended Vault V1.1)

---

## 1. Contexte et Positionnement Produit

### Le problème spécifique du Track 2
Dans la spécification **Lending Protocol V1.1 (Closed-Ended Vault)**, le cycle de vie du coffre est strictement borné par deux dates immuables inscrites au consensus :
* **`SubscriptionDate` :** Clôture de la phase de souscription. Tout `VaultDeposit` ultérieur est rejeté par le consensus.
* **`RedemptionDate` :** Date d'ouverture des rachats. Avant cette date, **tout `VaultWithdraw` est formellement bloqué par le protocole**.

Pendant toute la durée de vie du prêt sous-jacent (entre `SubscriptionDate` et `RedemptionDate`), **le capital des déposants est captif à 100 %**. En cas de besoin de liquidité immédiate, il n'existe aucune porte de sortie native dans le coffre.

### La solution SecondWave
**SecondWave** est la marketplace secondaire des coffres fermés XLS-65, adossée au moteur de notation de crédit **RiskLens** :
1. **« Exit the Wave » (Vendeur bloqué) :** Le déposant cède ses parts de coffre (tokens MPT) avec une décote (*discount*) contre du cash immédiat (RLUSD/XRP) sans attendre la `RedemptionDate`.
2. **« Catch the Wave » (Acheteur / Second entrant) :** Un investisseur injecte des capitaux frais, rachète les parts à prix réduit pour capter un rendement implicite bonifié (*Implied APY*), et conserve la position jusqu'à la `RedemptionDate` où il exécute le retrait final.
3. **Moteur RiskLens :** L'acheteur est guidé par un score de solvabilité impartial du courtier (AAA à D) et un simulateur de crise First-Loss.

---

## 2. Validation du "Minimum Bar" du Hackathon (Track 2)

Le projet valide point par point l'intégralité des prérequis stricts du sujet :

- [ ] **Création d'un Closed-Ended Vault :** Émission d'un coffre XLS-65 V1.1 configuré avec `SubscriptionDate` et `RedemptionDate`.
- [ ] **Dépôt de capital initial :** Dépôt d'un prêteur/déposant (Alice) avant `SubscriptionDate`.
- [ ] **Mise en place du courtier et prêt :** Déploiement d'un `LoanBroker` et émission d'un prêt `LoanSet` accepté et co-signé par l'emprunteur.
- [ ] **Exécution du déblocage (*Drawdown*) :** Transfert du principal vers l'emprunteur.
- [ ] **Remboursement périodique :** Exécution d'au moins un remboursement partiel ou total (`LoanPay`).
- [ ] **Démonstration d'une transaction rejetée (Garde-fou protocolaire obligatoire) :**
  * Tentative délibérée de `VaultWithdraw` par Alice **avant la `RedemptionDate`** $\rightarrow$ Rejet immédiat par le moteur `rippled` avec capture du code d'erreur (ex. `tec...`).
- [ ] **Résolution par SecondWave (Le cas d'usage) :**
  * Alice contourne l'impossibilité de retrait en vendant ses parts MPT avec décote sur SecondWave.
  * Bob achète les parts MPT en RLUSD.
- [ ] **Retrait du capital + rendement final :** Une fois la `RedemptionDate` franchie, Bob exécute avec succès le `VaultWithdraw` pour récupérer le capital initial et les intérêts cumulés.

---

## 3. Utilisation Stratégique du MCP XRPL

Le serveur MCP XRPL dédié sert de copilote d'ingénierie et de compilateur de retours DevRel :