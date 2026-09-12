# Plan Hackathon : SecondWave (XLS-65 / XLS-66)

---

## 1. Contexte et Double Livrable

### Le positionnement de SecondWave
SecondWave est une place de marché secondaire pour positions de coffres XLS-65 bloquées par des prêts XLS-66, couplée à un moteur d'arbitrage risque/rendement[cite: 1] :
1. **« Exit the Wave » (Vendeur bloqué) :** Un déposant dont le capital est immobilisé dans un prêt XLS-66 à terme fixe (ex. 90 jours) peut céder ses parts MPT contre du cash immédiat (RLUSD/XRP) en consentant une décote (*discount*).
2. **« Catch the Wave » (Acheteur / Second entrant) :** Un investisseur injecte de la liquidité fraîche pour racheter ces parts à prix réduit, captant un rendement implicite annualisé bonifié (*Implied APY*), calibré par un score de solvabilité du courtier (AAA à D)[cite: 1].

### Les deux livrables obligatoires
- [ ] **Prototype fonctionnel SecondWave :** Marketplace secondaire de parts MPT + Dashboard de scoring du courtier + Simulateur de crise (*stress-test*)[cite: 1].
- [ ] **Rapport DevX (`FEEDBACK_XLS65_XLS66.md`) :** Rapport exhaustif à la racine du dépôt documentant les frictions d'outillage, les manques de `xrpl.js`, les limites documentaires et les besoins de primitives manquantes[cite: 1].

---

## 2. Levier Stratégique : Utilisation du MCP XRPL

Le serveur MCP XRPL dédié sert d'accélérateur technique et d'outil d'audit comparatif en continu :

* **Validation des transactions :** Requêter le MCP pour extraire la structure exacte des payloads `VaultDeposit`, `LoanSet`, `LoanManage` et des offres de carnet d'ordres (`OfferCreate`) manipulant des tokens MPT[cite: 1].
* **Résolution des codes d'erreur :** Décoder instantanément les rejets de consensus émis par le moteur `rippled` (`tec...`, `tem...`, `ter...`) sans interrompre le cycle de dev[cite: 1].
* **Pipeline DevX automatisé :** Dès qu'un comportement réel sur Devnet diverge de la spécification officielle retournée par le MCP, consigner immédiatement l'écart dans `FEEDBACK_XLS65_XLS66.md` avec le payload et la trace d'erreur en preuve[cite: 1].

---

## 3. Glossaire et Règles du Protocole

### Objets de registre (*Ledger Entries*)
- [ ] `Vault` (XLS-65) : `AssetsTotal`, `AssetsAvailable`, `LossUnrealized`, `ShareMPTID`, `Scale`, `Flags`[cite: 1].
- [ ] `LoanBroker` (XLS-66) : `DebtTotal`, `DebtMaximum`, `CoverAvailable`, `CoverRateMinimum`, `CoverRateLiquidation`, `ManagementFeeRate`, `OwnerCount`, `VaultID`, `Account` (pseudo-compte)[cite: 1].
- [ ] `Loan` (XLS-66) : `PrincipalOutstanding`, `TotalValueOutstanding`, `ManagementFeeOutstanding`, `PaymentRemaining`, `NextPaymentDueDate`, `GracePeriod`, flags `lsfLoanImpaired` / `lsfLoanDefault`[cite: 1].

### Précisions critiques
* **Gestion des incidents :** Pas de transactions `LoanImpair` ou `LoanDefault` autonomes ; elles s'exécutent via `LoanManage` avec les indicateurs `tfLoanImpair` et `tfLoanDefault`[cite: 1].
* **Unités de taux :** Tous les taux d'intérêt et frais sont encodés en **dixièmes de point de base (1/10 bps)**, soit $1 = 0,001\ \%$ ou $100\ 000 = 100\ \%$[cite: 1].
* **Perte d'historique :** L'objet `Loan` est détruit sur le registre (`LoanDelete`) une fois soldé ou clôturé en défaut[cite: 1]. Le scoring historique nécessite un indexeur hors-chaîne[cite: 1].

---

## 4. Modélisation Financière et Algorithmes

### A. Marché Secondaire : Rendement Implicite (Implied APY)
Pour une part de coffre XLS-65 vendue avec décote sur le marché secondaire :

$$\text{Implied APY} = \left( \frac{\text{Valeur de rachat estimée à maturité}}{\text{Prix d'achat avec décote}} - 1 \right) \times \left( \frac{365}{\text{Jours restants sur le prêt}} \right)$$

* La valeur de rachat à maturité intègre le remboursement du principal et des intérêts contractuels du prêt XLS-66, nets des commissions de gestion du courtier (`ManagementFeeRate`)[cite: 1].

### B. Algorithme de Risque du Courtier (Score AAA → D)
L'acheteur évalue chaque offre selon la note globale de solvabilité du Loan Broker[cite: 1] :

$$\text{RiskScore} = 0,35 \times \text{FLCR} + 0,25 \times \text{NPL} + 0,20 \times \text{Concentration} + 0,10 \times \text{Liquidité} + 0,10 \times \text{DID}$$[cite: 1]

* **FLCR (35 %) :** $\frac{\text{CoverAvailable}}{\max(\text{DebtTotal}, \epsilon)}$ (ratio de capital de première perte)[cite: 1].
* **NPL (25 %) :** $\frac{\text{Prêts en retard ou défaut}}{\text{Prêts totaux émis}}$[cite: 1].
* **Concentration (20 %) :** $\frac{\text{Principal du prêt le plus élevé}}{\max(\text{DebtTotal}, \epsilon)}$[cite: 1].
* **Liquidité résiduelle (10 %) :** $\frac{\text{AssetsAvailable}}{\max(\text{AssetsTotal}, \epsilon)}$[cite: 1].
* **Identité DID (10 %) :** Score binaire ou graduel selon les accréditations vérifiées (XLS-40)[cite: 1].

#### Grille d'attribution des notes
* `AAA` : $\ge 85$[cite: 1]
* `AA` : $\ge 75$[cite: 1]
* `A` : $\ge 65$[cite: 1]
* `BBB` : $\ge 55$[cite: 1]
* `BB` : $\ge 45$[cite: 1]
* `B` : $\ge 35$[cite: 1]
* `CCC` : $\ge 25$[cite: 1]
* `CC` : $\ge 15$[cite: 1]
* `C` : $\ge 5$[cite: 1]
* `D` : $< 5$[cite: 1]

### C. Formules de Référence du Protocole
* **Rachat XLS-65 (*Redeem*) :**
  $$\Delta\text{Assets} = \frac{\Delta\text{Shares} \times (\text{AssetsTotal} - \text{LossUnrealized})}{\text{SharesTotal}}$$[cite: 1]
* **Liquidation First-Loss XLS-66 :**
  $$\text{DefaultCovered} = \min(\text{MinimumCover} \times \text{CoverRateLiquidationPct}, \text{DefaultAmount}, \text{CoverAvailable})$$[cite: 1]

---

## 5. Architecture Technique

```mermaid
flowchart TD
  subgraph Ledger["XRPL Devnet"]
    V[Vault XLS-65]
    L[Loan XLS-66]
    DEX[DEX / Carnet d'ordres MPT]
  end

  subgraph Ingestion["Backend Indexeur (Node.js)"]
    WS[WebSocket Listener]
    MCP[Client MCP XRPL]
    Parser[Parser Transactions & Metadata]
    DB[(SQLite / Cache local)]
  end

  subgraph Engine["Moteur Métier SecondWave"]
    Scoring[Score de Solvabilité AAA-D]
    YieldCalc[Calculateur Implied APY]
    StressTest[Simulateur Pertes First-Loss]
  end

  subgraph UI["Frontend Next.js"]
    Market[Place de Marché Secondaire]
    ExitModal[Interface Sortie Anticipée]
    Dashboard[Fiche Courtier & Leaderboard]
    SimView[Simulateur Graphique]
  end

  WS -->|Transactions stream| Parser
  MCP -->|Validation Schémas & Types| Parser
  Parser --> DB
  DB --> Scoring
  DB --> YieldCalc
  Scoring --> UI
  YieldCalc --> Market
  StressTest --> SimView