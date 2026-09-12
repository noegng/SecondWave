---
name: Plan hackathon RiskLens
overview: "Créer un fichier `PLAN_RISKLENS.md` à la racine du projet : planification complète du hackathon (prototype RiskLens + rapport DevX), ancrée sur les primitives réelles de XLS-65/66 présentes dans les deux docs du dossier et sur l'état actuel de xrpl.js (4.6.0+)."
todos:
  - id: write-plan-file
    content: Rédiger PLAN_RISKLENS.md à la racine avec les 11 sections décrites, en français, avec cases à cocher et références aux sections des specs
    status: completed
  - id: verify-formulas
    content: Relire les formules (double taux XLS-65 §3.1.7, liquidation XLS-66 §3.10.5, seuils LoanSet §3.8.5) et les reporter exactement dans le fichier
    status: completed
  - id: seeding-timeline
    content: Détailler la séquence de seeding et le timing impair → grace → default compatible avec les contraintes min 60 s
    status: completed
isProject: false
---

# Plan hackathon RiskLens (XLS-65 / XLS-66)

## Livrable de cette tâche

Un seul fichier : `PLAN_RISKLENS.md` à la racine de `c:\Users\Noe\Documents\ripple`, en français, structuré en phases avec cases à cocher, référençant les sections précises de [xls-65-full_doc.md](xls-65-full_doc.md) et [xls-66_full_doc.md](xls-66_full_doc.md). Aucun code n'est écrit à ce stade.

## Points de vérité issus des docs à intégrer dans le plan

Éléments vérifiés dans les specs qui corrigent ou précisent le brief :

- Objets ledger : `Vault` (`AssetsTotal`, `AssetsAvailable`, `LossUnrealized`, `ShareMPTID`, `Scale`, `Flags`), `LoanBroker` (`DebtTotal`, `DebtMaximum`, `CoverAvailable`, `CoverRateMinimum`, `CoverRateLiquidation`, `ManagementFeeRate`, `OwnerCount`, `VaultID`, `Account` pseudo-compte), `Loan` (`PrincipalOutstanding`, `TotalValueOutstanding`, `ManagementFeeOutstanding`, `PaymentRemaining`, `NextPaymentDueDate`, `GracePeriod`, flags `lsfLoanDefault` / `lsfLoanImpaired`).
- Il n'y a pas de `FirstLossCapitalAccount` ni `MinFirstLossRatio` : ce sont `LoanBroker.Account` (pseudo-compte) et `CoverRateMinimum`. Il n'y a pas de tx `LoanImpair` / `LoanDefault` séparées : c'est `LoanManage` avec flags `tfLoanImpair` / `tfLoanUnimpair` / `tfLoanDefault`.
- Taux exprimés en 1/10 de bps (1 = 0,001 %) partout : à convertir dans l'indexeur.
- Formule de liquidation réelle (XLS-66 §3.10.5) : `DefaultCovered = min(DebtTotal × CoverRateMinimum × CoverRateLiquidation, DefaultAmount, CoverAvailable)`. Le first-loss n'absorbe donc qu'une fraction bornée par défaut : le simulateur doit implémenter cette formule exacte, pas un simple « couverture − pertes ». C'est un argument fort pour le pitch (protection déposants moins forte que l'intuition).
- Double taux de change (XLS-65 §3.1.7) : dépôt sur `AssetsTotal / Shares`, retrait/redeem sur `(AssetsTotal − LossUnrealized) / Shares`. Exception : détenteur unique de shares non pénalisé.
- Contrainte de seeding : `PaymentInterval ≥ 60 s`, `GracePeriod ≥ 60 s` et ≤ `PaymentInterval` ; `tfLoanDefault` refusé (`tecTOO_SOON`) avant `NextPaymentDueDate + GracePeriod`. Pour créer un défaut rapidement : `LoanManage tfLoanImpair` (ramène `NextPaymentDueDate` à maintenant) puis attendre `GracePeriod` puis `tfLoanDefault`.
- `Loan` supprimé via `LoanDelete` (uniquement si `PaymentRemaining == 0`) : l'historique doit être reconstruit depuis les métadonnées des transactions, pas depuis l'état.
- `vault_list` est Clio-only (potentiellement indisponible sur Devnet) : prévoir fallback `ledger_data` filtré par type ou `account_objects` sur les courtiers seedés.
- xrpl.js ≥ 4.6.0 supporte tous les tx types et fournit `signLoanSetByCounterparty` / `combineLoanSetCounterpartySigners` : le feedback DevX devra être factuel (tester ce qui manque réellement plutôt que supposer).

## Structure du fichier `PLAN_RISKLENS.md`

1. Contexte et double livrable (prototype + `FEEDBACK_XLS65_XLS66.md`), critères du jury.
2. Proposition de valeur et pitch (asymétrie d'information déposant / courtier).
3. Glossaire protocole : tableau objets / champs / transactions réellement disponibles (corrige le brief).
4. Algorithme de Risk Score : 5 métriques, poids, formule on-chain exacte, échelle AAA→D, précision sur l'unité 1/10 bps.
5. Architecture technique (diagramme mermaid) : Devnet WS → indexeur Node (souscription `transactions` + filtrage manuel + `ledger_entry`) → SQLite → API → Next.js. Documentation des events à persister (`LoanSet`, `LoanPay`, `LoanManage`, `LoanDelete`, `VaultDeposit/Withdraw`, `LoanBrokerCoverDeposit/Withdraw`).
6. Phases chronologiques (J-7 → J-1 préparation, H0–H48 hackathon découpé en blocs de 4–6 h, démo) avec cases à cocher et responsable/durée estimée.
7. Script de seeding : 3 profils de courtiers (bon élève / spéculateur / défaillant), séquence exacte de transactions et paramètres (`CoverRateMinimum`, `CoverRateLiquidation`, `PaymentInterval` court), timing de la crise impair → default.
8. UI : vue macro, leaderboard, fiche courtier + simulateur (avec la formule réelle de liquidation et affichage dépôt vs retrait rate).
9. Méthode de capture DevX : journal de friction au fil de l'eau (template d'entrée), catégories du rapport, liste des hypothèses à vérifier empiriquement (typage `Loan`/`Vault` dans xrpl.js, helpers de conversion, filtrage WS, erreurs `tec`, tutoriel crise).
10. Risques et plans B (Devnet instable, `vault_list` absent, latence, amendement modifié, données vides) et check-list J-1.
11. Stack recommandée et arborescence de dépôt cible.
