# Roadmap — SecondWave

> **Livrable double :** un prototype **ET** un retour structuré sur les frictions de tooling et de docs.
> Le second compte pour la moitié — il n'est pas optionnel.

**Répartition :** Hugo → `core`, `vault`, `settlement`, `orderbook`, `fixtures`, `cli` · Noé → `analyst`
**Règle git :** ce dont on dépend tous les deux part sur `main` vite. Le reste sur sa branche, merges fréquents.

---

# P0 — `packages/core` ✅ *fait — vérifié sur le Devnet*

Le contrat d'interface entre nos deux moitiés. Tant qu'il n'existe pas, Noé travaille à l'aveugle.

- [x] **P0.1 — Connexion**
  - client XRPL sur `wss://s.devnet.rippletest.net:51233`
  - ✅ **plus aucune definition custom** : `xrpl.js@5.2.0-beta.1` embarque
    `ripple-binary-codec@2.11.0`, qui connaît `VaultKind`, `SubscriptionDate`,
    `RedemptionDate` et `LEVersion`. Le contournement par `server_definitions` est mort.
  - `fundAccount()` sur `https://faucet.devnet.rippletest.net/accounts`, avec retry *(le faucet throttle)*
- [x] **P0.2 — Soumission**
  - `submit(client, tx, wallet)` → `submitAndWait` natif, plus de chaîne manuelle
  - **file d'attente par compte** : `autofill` lit la séquence à l'appel, deux tx parallèles du même compte meurent en `tefPAST_SEQ`
  - ⚠️ `NetworkID` omis par le SDK · séquences lues en `ledger_index:'current'`
  - `submitLoanSet()` reste manuel : **il porte le fix `CPT\0`**
- [x] **P0.3 — ⭐ La traversée à trois niveaux**
  - `readVaultGraph(vaultId)` → vault → brokers du pseudo-compte → prêts de chaque pseudo-broker
  - `phaseOf(vault)` → `Subscription` · `Investment` · `Redemption`
- [x] **P0.4 — Positions & détenteurs**
  - `shareBalance(account, mptId)` *(objet absent = solde nul)*
  - `holderMap(vault)` — rejeu d'`account_tx` sur le pseudo-compte, **par la meta uniquement** :
    tous les nœuds `MPToken` donnent le solde absolu après chaque transaction, quel que soit
    le type de transaction. Vérifié : la somme retombe sur `shares.OutstandingAmount`
    → `reconciles: true` et `concentration` sortent gratuitement.
  - ⚠️ `mpt_holders` n'existe pas sur rippled. C'est le contournement.
- [x] **P0.5 — Éligibilité** : `isDomainMember(account, domainId)` *(credential émis **et** accepté **et** non expiré)*
- [ ] **P0.6 — Merge sur `main` + prévenir Noé**

---

# P1 — `packages/vault` — le cycle de vie ✅ *écrit, exercé par le générateur*

- [x] **P1.1 — Identité & domaine**
  - `CredentialCreate` puis `CredentialAccept` *(les deux : un credential émis mais non accepté ne vaut rien)*
  - `PermissionedDomainSet` → récupérer le `DomainID`
- [x] **P1.2 — Création de vault**
  - privé closed-ended : `Flags: 0x00010000` + `DomainID` + `VaultKind: 1` + `SubscriptionDate`/`RedemptionDate`
  - ⚠️ écart entre les deux dates ∈ **[180 s, 30 ans[**
  - ⚠️ XRP et MPT : **ne pas envoyer `Scale`** → `temMALFORMED`
  - ⚠️ le `Fee` de `VaultCreate` vaut **une owner reserve** (0,2 XRP), pas 10 drops
- [x] **P1.3 — Dépôts & parts**
  - `VaultDeposit`, lecture des parts, vérification du gate *(un non-membre prend `tecNO_AUTH`)*
  - flags de l'issuance : **56** = public transférable · **60** = privé transférable
- [x] **P1.4 — Brokers & cover**
  - `LoanBrokerSet` ⚠️ **exige un vault closed-ended** sous V1_1 → sinon `tecNO_PERMISSION`
  - ⚠️ `CoverRateMinimum` et `CoverRateLiquidation` : **les deux à zéro ou les deux non nuls**, et **immuables**
  - `LoanBrokerCoverDeposit` / `Withdraw`
- [x] **P1.5 — Prêts** *(nécessaire : sans prêt, la NAV est figée et il n'y a rien à analyser)*
  - `LoanSet` avec **le fix de co-signature** : `CPT\0` = `43505400` en simple, `CPM\0` = `43504D00` en multisig
  - ⚠️ `StartDate` n'est **pas** un champ de `LoanSet` · `Data` est accepté puis **jeté**
  - ⚠️ dernière échéance ≥ **60 s avant `RedemptionDate`**
  - `LoanPay`, `LoanManage` (`tfLoanImpair`, `tfLoanDefault`)

---

# P2 — `fixtures/` — le générateur de monde ✅ *`npm run world`*

Une commande, un écosystème complet. **C'est le jeu de test de Noé et la démo en même temps.**

- [x] **P2.1 — Socle** : émetteur de credentials, domaine, 4-5 comptes membres + **1 non-membre** (pour démontrer le gate)
- [x] **P2.2 — Vaults aux profils délibérément contrastés**
  - un **sain** : cover à jour, prêts ponctuels, faible concentration
  - un à **garantie nulle** : les deux `CoverRate` à 0 *(c'est légal)*
  - un **multi-brokers** : deux brokers aux taux opposés sur le même vault
  - un **concentré** : quasi tout le capital sur un seul emprunteur
- [x] **P2.3 — Prêts en détresse**
  - au moins un **défaillable non déclaré** : `now > NextPaymentDueDate + GracePeriod` sans le flag de défaut
  - un **impairé** *(`LossUnrealized > 0`)*
  - un **cover vidé** après coup *(possible quand `DebtTotal = 0`)*
- [x] **P2.4 — Positions à vendre** : des déposants avec des parts, prêts à être mis au carnet
- [x] **P2.5 — Persistance** : dump du monde en JSON ⚠️ **contient des seeds → `state*.json` est gitignoré**
- [ ] **P2.6 — Livrer à Noé** : le dump + `readVaultGraph` = il peut tout tester

---

# P3 — `packages/settlement` — la revente ✅ *porté, simplifié pour 5.2.0-beta.1*

Source : `~/Projet/xrpl-xls6566/settlement.mjs`

- [x] **P3.1 — Preflight** : parts transférables (bit 32) · éligibilité de l'acheteur *(credential émis **et** accepté **et** non expiré)* · soldes · autorisation déjà présente ou non · **`simulate`**
  - ⚠️ simuler l'**autorisation** si l'acheteur n'a pas de `MPToken` — simuler le transfert donne un faux `tecNO_AUTH`
- [x] **P3.2 — Construction du Batch 3 jambes**
  - `MPTokenAuthorize` (acheteur) → `Payment` des parts → `Payment` du prix
  - ⚠️ l'autorisation **en première position** · `tfAllOrNothing` · `signMultiBatch()` · minimum 2 jambes
- [x] **P3.3 — Evidence** : reconstruire le `BatchExecutions` manquant via `account_tx` sur la plage `[ledgerIndex, ledgerIndex]`
- [x] **P3.4 — Réconciliation** : soldes avant/après. **La seule vérité** → `stage: 'silent-failure'` si rien n'a bougé
- [ ] **P3.5 — Tests** : les 3 cas — acheteur éligible, non éligible, preflight contourné

---

# P4 — `packages/orderbook` ✅

- [x] **P4.1 — Modèle** : `{ id, vaultId, seller, shares, price, expiry, status }`
- [x] **P4.2 — Stockage** : un fichier JSON suffit
- [x] **P4.3 — API** : `post`, `list(vaultId?)`, `cancel`, `get`
- [x] **P4.4 — Filtres d'éligibilité** : n'afficher à un acheteur que ce qu'il **peut** recevoir *(vault privé → domaine ; parts non transférables → exclure)*
- [x] **P4.5 — Historique des prix** : les swaps passés sont lisibles on-chain — les deux jambes sont dans le même Batch

---

# P5 — Jonction

- [x] **P5.1 — Contrat d'appel** figé dans `packages/analyst/src/index.mjs`
  - `analyse({ graph, holders, order }) → { score, verdict, nav, fairPrice, signaux }`
  - un **placeholder** occupe la place : Noé remplace le corps, pas la signature
- [x] **P5.2 — Note affichée à côté de chaque offre** — `cli book <acheteur>`
- [x] **P5.3 — Chemin complet** — `cli buy <offre> <acheteur>` enchaîne
  analyse → preflight → batch → evidence → réconciliation → `fill()`
- [x] **P5.4 — `apps/cli`** : `vaults`, `book`, `sell`, `buy`, `history`, `demo`
- [ ] **P5.5 — Brancher le vrai analyste** quand Noé livre

⚠️ **Le monde vieillit.** Les échéances des prêts tombent toutes les 120 s : un
monde généré il y a une heure a tous ses prêts en retard et le vault « sain » ne
l'est plus. **Relancer `npm run world` moins de dix minutes avant la démo.**

---

# P6 — Livrables *(à ne pas commencer le dimanche matin)*

- [ ] **P6.1 — ⚠️ Réécrire le README pour la remise**
  - la version actuelle est **une note technique pour l'agent de Noé**, pas une présentation
  - version finale : le problème, la solution, la démo, l'installation, l'équipe — pour un lecteur extérieur
- [ ] **P6.2 — ⭐ Le rapport de friction** *(la moitié de la note)* — **brouillon lisible : `FEEDBACK_RENDU.md`** (annexes `FEEDBACK.md` + `FEEDBACK_XLS65_XLS66.md`)
  - 8 points déjà rédigés au format imposé, mesurés pendant le build
  - source : `datablockchain/4 - XRPL/XRP Ledger (L1)/Hackathons/⚠️ Frictions & contournements — le projet.md` — **34 points déjà documentés**
  - les P0 : `LoanSet` cassé dans les SDK (avec le fix) · le Batch qui ment sur son résultat · aucune RPC de lecture côté XLS-66 · la doc qui pointe un réseau mort · `LendingProtocolV1_1` non documenté
  - **prévoir d'en reproduire 3-4 en direct pendant la démo** — c'est ce que Ripple demande explicitement
- [x] **P6.3 — ~~La PR du correctif `LoanSet`~~ — sans objet : Ripple a corrigé pendant l'événement**
  - `5.2.0-beta.1` embarque la table `SIGNING_ENCODERS` par rôle ; revérifié sur
    la chaîne, le helper publié fonctionne (`probes-marche/05-verif-beta1.mjs`)
  - **restent à signaler** : la config CI s'arrête à `fixCleanup3_2_0` (la
    régression peut revenir sans alerte), et `xrpl-py` porte toujours le bug
  - garder l'histoire pour le pitch : bug bloquant trouvé, diagnostiqué, corrigé
- [ ] **P6.4 — Le pitch (60 s)**
  - mener **par les découvertes**, pas par le produit : le défaut à 95 %, la déposante piégée, le cover vidé
  - puis la sortie, puis l'analyste
  - le moment clé : **deux offres au même prix, deux notes opposées, et pourquoi**
- [ ] **P6.5 — Questions à poser aux gens de Ripple**
  - `MPTokensV2` (XLS-82) est-il prévu ? *(si les parts se tradent sur le DEX natif, le marché P2P perd son intérêt)*
  - le blocage en phase Investment est-il définitif ?
  - le swap de parts via Batch est-il un usage supporté ou un effet de bord ?

---

# Ordre conseillé

**P0 → P2 → P1 → P3 → P4 → P5 → P6**

P2 avant P1 peut surprendre : écrire le générateur de monde **force** à faire fonctionner toute la chaîne de bout en bout, et il débloque Noé immédiatement. Les briques individuelles se peaufinent ensuite.

**Le code des phases P1 et P3 existe déjà**, testé, dans `~/Projet/xrpl-xls6566/` — c'est surtout du portage.
