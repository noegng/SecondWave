# XLS-65 / XLS-66 DevX Feedback Report (Track 2 Focus)

### 1. Questions Cibles du Brief Officiel
- **Compréhension du modèle :** La relation Vault ↔ Loan Broker ↔ Loan est-elle intuitive ?
- **Paramètres de Première Perte :** Les champs CoverRateMinimum / CoverRateLiquidation
  se comportent-ils comme leur nom l'indique ?
- **Co-signature LoanSet :** Frictions rencontrées lors de la signature conjointe
  Broker / Borrower via les librairies clientes.
- **Support SDK vs Raw JSON :** Quelles transactions ont nécessité du JSON brut
  faute de typage natif dans xrpl.js (notamment Closed Vault V1.1) ?
- **Lisibilité on-chain :** A-t-il été possible de lire la valeur de position,
  l'utilisation et le rendement sans devoir déduire arbitrairement des objets ledger ?
- **Adéquation Docs vs Réalité :** Écarts constatés entre la doc et le comportement
  effectif sur Devnet.

### 2. Retours Spécifiques au Track 2 (Closed-Ended Vault)
- **Ergonomie des dates :** Précision sur les rejets en cas d'incohérence entre la
  maturité du prêt et la RedemptionDate du coffre.
- **Clarté du message d'erreur lors du retrait anticipé :** Analyse de la lisibilité
  du code tec... retourné lors du refus de VaultWithdraw avant RedemptionDate.
- **Transférabilité des MPT sous contrainte temporelle :** Comportement du carnet
  d'ordres DEX lors du trading de tokens de parts d'un coffre fermé.

### 3. Fiches d'Anomalie Formatées (Issues)
- Contexte / Issue / Impact / Evidence (hash tx / traces MCP) / Suggestion