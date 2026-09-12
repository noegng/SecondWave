# Roadmap — SecondWave

> ## État au samedi soir
>
> **P0 → P5 sont faits.** Le socle tourne, les tests passent, le CLI démarre.
> Ce qui reste tient en une liste courte, et elle est en bas de ce fichier (**P7**).
>
> | | |
> |---|---|
> | `core` · `vault` · `fixtures` | durcis, règles encodées, monde v2 + `snapshot.json` |
> | `settlement` | **deux rails** — Batch et HTLC — plus moyens de paiement et preflight complété |
> | `orderbook` | carnet, éligibilité, historique de prix |
> | `analyst` | livré par Noé, branché au CLI |
> | `probes/` · `probes-marche/` | ~420 cas mesurés, 3 rapports |
>
> 🔴 **Trois fichiers de feedback coexistent à la racine** — voir P7.1.

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
- [x] **P0.6 — Merge sur `main` + prévenir Noé**

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
- [x] **P2.6 — Livrer à Noé** — `snapshot.json` + `npm run analyse`, il travaille hors ligne

---

# P3 — `packages/settlement` — la revente ✅ *dépassé : deux rails livrés*

**Au-delà du plan initial** : `batch.mjs` · `htlc.mjs` (deux escrows liés par une
`Condition`) · `condition.mjs` · `amounts.mjs` (XRP · IOU · MPT) · `preflight.mjs`
avec le seuil de solvabilité au drop près. Lancer : `npm run test:rails`.

Source : `~/Projet/xrpl-xls6566/settlement.mjs`

- [x] **P3.1 — Preflight** : parts transférables (bit 32) · éligibilité de l'acheteur *(credential émis **et** accepté **et** non expiré)* · soldes · autorisation déjà présente ou non · **`simulate`**
  - ⚠️ simuler l'**autorisation** si l'acheteur n'a pas de `MPToken` — simuler le transfert donne un faux `tecNO_AUTH`
- [x] **P3.2 — Construction du Batch 3 jambes**
  - `MPTokenAuthorize` (acheteur) → `Payment` des parts → `Payment` du prix
  - ⚠️ l'autorisation **en première position** · `tfAllOrNothing` · `signMultiBatch()` · minimum 2 jambes
- [x] **P3.3 — Evidence** : reconstruire le `BatchExecutions` manquant via `account_tx` sur la plage `[ledgerIndex, ledgerIndex]`
- [x] **P3.4 — Réconciliation** : soldes avant/après. **La seule vérité** → `stage: 'silent-failure'` si rien n'a bougé
- [x] **P3.5 — Tests** — `fixtures/test-settlement.mjs` (3 cas) + `npm run test:rails`

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
- [x] **P5.5 — Le vrai analyste est branché** — le CLI affiche sa notation

⚠️ **Le monde vieillit.** Les échéances des prêts tombent toutes les 120 s : un
monde généré il y a une heure a tous ses prêts en retard et le vault « sain » ne
l'est plus. **Relancer `npm run world` moins de dix minutes avant la démo.**

---

# P6 — Livrables *(à ne pas commencer le dimanche matin)*

- [ ] **P6.1 — ⚠️ Réécrire le README pour la remise**
  - la version actuelle est **une note technique pour l'agent de Noé**, pas une présentation
  - version finale : le problème, la solution, la démo, l'installation, l'équipe — pour un lecteur extérieur
- [ ] **P6.2 — ⭐ Le rapport de friction** *(la moitié de la note)* — **commencé : `FEEDBACK.md`**
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

---

# P7 — Avant la remise · dimanche 13:00

Tout le reste est fait. Voilà ce qui manque, dans l'ordre où ça doit être traité.

- [ ] **P7.0 — ⭐ Trier `SECURITY-NOTES.md` avant d'en parler à qui que ce soit**
  Douze notes, réparties sur deux fichiers. **La plupart décrivent le modèle de
  menace assumé de XLS-66**, pas des failles : crédit non collatéralisé, analyse
  hors chaîne, aucune liquidation. Annoncer « on a trouvé un rug-pull » sur un
  protocole conçu comme ça coûte en crédibilité.
  → **Ne garder que ce qui ressemble à un défaut, pas à une conséquence.**
  Candidat unique à ce stade : le **gel perpétuel de l'escrow** (`Finish`
  `tecNO_AUTH` **et** `Cancel` `tecNO_PERMISSION` — les deux sorties fermées,
  objet immortel). C'est une interaction MPT-escrow × domaine permissionné, et
  les MPT dans l'escrow ne sont documentés nulle part.
  → Le formuler **en question** : « on n'arrive ni à dénouer ni à annuler cet
  escrow, est-ce qu'on rate quelque chose ? »
  → Le reste (rug-pull, clawback IOU, cover à dette nulle, gel par le domaine)
  part **dans le pitch** comme signaux que l'analyste détecte — c'est sa raison d'être.

- [ ] **P7.1 — 🔴 Trancher entre les trois rapports de feedback**
  Trois fichiers coexistent à la racine et un seul sera lu :
  `FEEDBACK.md` (1 990 mots, 12 frictions, format jury) ·
  `FEEDBACK_XLS65_XLS66.md` (1 526 mots) · `FEEDBACK_RIPPLE.md` (44 mots).
  **Un seul doit rester à la racine**, les autres fusionnés ou déplacés en annexe.
- [ ] **P7.2 — 🔴 Remonter `SECURITY-NOTES.md` de vive voix à Maxime ou Shota**
  *Obligation du règlement, avant toute présentation.* Le gel perpétuel de
  l'escrow et la recette de rug-pull en font partie.
- [ ] **P7.3 — Réécrire le README**
  La version actuelle est la note technique pour l'agent de Noé. Il faut : ce que
  fait le projet, l'installation, **le track, l'environnement, la version de lib,
  et toutes les transactions XLS-65/66 utilisées** (la liste est dans `PROJET.md`).
- [ ] **P7.4 — Ranger la racine**
  `PLAN_SecondWave.md`, `PLAN_SecondWave_v1.1.md`, `PLAN_BUILD_FINAL.md`,
  `PLAN_RISKLENS.md`, `QA-hugo1.md`, `xls-65-full_doc.md`, `xls-66_full_doc.md`
  — brouillons de travail, à archiver dans un dossier ou à supprimer. Un dépôt
  public remis à un jury ne doit pas ressembler à un bureau en fin de sprint.
- [ ] **P7.5 — Le deck** — 10 slides maximum
- [ ] **P7.6 — Régénérer le monde** *(`npm run world`, puis re-snapshot)*
  ⚠️ **Moins de 30 minutes avant la démo.** Les échéances tombent toutes les
  120 s : le monde actuel est entièrement en phase Redemption, les prêts sont tous
  en retard, et le vault « sain » ne l'est plus.
- [ ] **P7.7 — Répéter la démo une fois en entier**, monde fraîchement régénéré
- [ ] **P7.8 — Formulaire DevEx** : membres et handles GitHub

---

# P8 — Le front *(jamais entré dans la roadmap — décision à prendre)*

Repoussé au premier jour (« on voit pour le front plus tard »), jamais planifié
depuis. **Le CLI fait déjà la démo complète et il marche.** Un front est du
confort de présentation, pas une exigence du règlement — qui demande un dépôt
public, un README, des liens de transaction, un deck et le rapport de feedback.

**Arbitrage** : ne commencer un front que si le reste de P7 est bouclé. Un CLI qui
tourne bat une page web à moitié finie qui plante sur scène.

- [ ] **P8.1 — Décider : front ou pas.** Si non, l'écrire dans le README comme un
  choix assumé (« l'interface est le terminal »), pas comme un manque.
- [ ] **P8.2 — Version minimale, si oui** — **lecture seule**, aucune signature :
  - la liste des vaults avec la note de l'analyste et ses signaux
  - le carnet d'offres, avec décote et verdict liquidité / détresse
  - l'historique des prix relu on-chain
  - alimentée par `snapshot.json` → **aucun réseau, rien ne peut planter en démo**
- [ ] **P8.3 — Version connectée** *(seulement si tout le reste est fait)*
  - `xrpl-connect` (l'adaptateur de portefeuille listé dans les ressources du Notion)
  - l'utilisateur signe **depuis son propre portefeuille**, plus de seeds en clair
  - ⚠️ change le modèle : aujourd'hui le CLI signe avec les seeds de `state.json`

---

# P9 — Tests avec un vrai portefeuille

Aujourd'hui **tout est signé avec des seeds en clair** lus dans `state.json`.
C'est parfait pour des sondes, ce n'est pas ce qu'un utilisateur ferait.

- [ ] **P9.1 — Monter `xrpl-connect`** et se connecter avec un portefeuille de dev
- [ ] **P9.2 — Rejouer le chemin complet en signant depuis le portefeuille** :
  `MPTokenAuthorize` → l'offre → le `Batch` co-signé
  ⚠️ le point dur : **l'acheteur doit co-signer le Batch** (`BatchSigners`). Vérifier
  que l'adaptateur sait faire signer autre chose qu'une transaction simple — si non,
  c'est une friction à remonter, et une vraie.
- [ ] **P9.3 — Le rail HTLC depuis un portefeuille** — quatre signatures au lieu d'une
- [ ] **P9.4 — Noter ce qui manque côté portefeuille** pour les transactions
  XLS-65/66 : sont-elles seulement affichées correctement avant signature ?
