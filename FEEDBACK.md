# Rapport de feedback développeur — SecondWave

**Track** 2 — Lending Protocol · **Flavour** Loaded (Permissioned Domains + Credentials)
**Environnement** Devnet public XRPL, `wss://s.devnet.rippletest.net:51233`
**rippled** 3.4.0-rc5 — `LendingProtocolV1_1` et `fixCleanup3_4_0` actifs
**Libs** `xrpl.js@5.2.0-beta.1` · `ripple-binary-codec@2.11.0` · Node ≥ 20

> Frictions `client libraries` **revalidées une par une contre `5.2.0-beta.1`**
> (`probes-marche/06-revalidation-beta1.mjs`). Rien ici n'est déjà corrigé, sauf
> la n°1 — gardée parce qu'elle documente un bloquant réel de la beta.0 et sa
> disparition en beta.1, revérifiée sur la chaîne.

Environ 420 cas exécutés sur le Devnet, sur une trentaine de vaults. Chaque entrée
est rejouable par un script du dépôt. Versions longues : `probes/FRICTIONS.md`
(vault) et `probes-marche/FRICTIONS.md` (marché).

---

# Bloquants

### 1 · `client libraries` — co-signature `LoanSet` invalide — ✅ **corrigé en `5.2.0-beta.1`**

Le helper signait avec le préfixe historique `STX\0` alors que `fixCleanup3_4_0`,
actif sur ce Devnet, exige `CPT\0` en simple signature et `CPM\0` en multisig.
Refus aux *local checks* : `fails local checks: Counterparty: Invalid signature.`
**Aucun `LoanSet` n'était soumettable depuis le SDK publié** — la transaction
centrale de XLS-66, et l'exemple officiel `createLoan.js` avec elle.

Les bons encodeurs existaient déjà dans `ripple-binary-codec@2.11.0`, avec
l'amendement nommé en commentaire ; ils n'étaient jamais appelés — et
`.ci-config/xrpld.cfg` s'arrêtant à `fixCleanup3_2_0`, la CI ne pouvait pas voir
la casse.

**Corrigé dans `5.2.0-beta.1`**, la version vers laquelle le brief a basculé en
cours d'événement : elle route la signature par une table d'encodeurs indexée sur
le rôle (`transaction` / `counterparty` / `sponsor`). Nous l'avons revérifié sur
la chaîne avec le helper publié, sans contournement : `tesSUCCESS`, objet `Loan`
créé —
`devnet.xrpl.org/transactions/929864F308A9D9A037CCF09219D9867471A1E28393B2CE95FB67429C3B5E5F8D`

**Deux points restent ouverts** : la config CI n'active toujours pas
`fixCleanup3_4_0`, donc la régression peut revenir sans alerte ; et `xrpl-py`
(`counterparty_signer.py`) porte le même bug, son codec ayant d'abord besoin des
deux préfixes.

**Repro** : `probes/campaign-f2.mjs` (le bug) · `probes-marche/05-verif-beta1.mjs`
(la correction) · **Sévérité** bloquant · rencontré en beta.0, **corrigé en beta.1**

### 2 · `UX` — le résultat d'un `Batch` ne dit pas s'il a produit un effet

Précisons d'emblée, parce que la formulation naïve est attaquable : `tesSUCCESS`
sur un `tfAllOrNothing` dont rien n'a appliqué est **défendable** — le drapeau
promet un invariant, « tout ou rien », et le protocole l'a fait respecter.

Le problème est ailleurs. **Les deux issues sont indiscernables.** Huit `Batch`
rejoués depuis le ledger, cinq qui ont livré des parts et trois qui n'ont rien
fait :

| Résultat | Nœuds dans la meta | Jambes appliquées |
|---|---|---|
| `tesSUCCESS` | 1 | **2** |
| `tesSUCCESS` | 1 | **0** |

Une seule combinaison observée sur les huit : `tesSUCCESS` / 1 nœud. Ce nœud est
la ponction de frais sur le compte qui porte l'enveloppe. **Rien d'autre.**

Un appelant ne peut donc pas savoir si son échange a eu lieu. Et ce n'est pas une
question d'interprétation : **XLS-56 spécifie un `BatchExecutions` dans la
métadonnée**, exactement pour distinguer les deux cas. Il est absent.

**Contournement** : les jambes internes sont en réalité des transactions à part
entière, dans le même ledger, avec leur propre empreinte. On les récupère par
`account_tx` sur la plage `[ledgerIndex, ledgerIndex]` de chaque compte impliqué —
c'est le `BatchExecutions` reconstruit à la main (`packages/settlement`, couche
*evidence*). Puis on réconcilie les soldes avant/après, seule preuve réelle.

**Demande** : que `BatchExecutions` soit fourni comme la spec l'annonce. À défaut,
que le résultat distingue « appliqué » de « rien appliqué ».
**Repro** : `node fixtures/test-settlement.mjs`, cas 3 · **Sévérité** élevée · rippled 3.4.0-rc5

---

# Élevées

### 3 · `documentation/tutorials` — `60 ≤ GracePeriod ≤ PaymentInterval`, nulle part, et `temINVALID` nu

Tout `LoanSet` avec `GracePeriod < 60` ou `> PaymentInterval` — donc aussi tout
`PaymentInterval < 60` — échoue en `temINVALID` « The transaction is ill-formed »,
sans nommer le champ. Balayage : grace 59 ❌ / 60 ✅ / = interval ✅ / interval+1 ❌.
**Une session de debug entière perdue dessus**, trois hypothèses fausses avant de
balayer.
**Repro** : `probes/g-sweep.mjs` · **Sévérité** élevée · rippled 3.4.0-rc5

### 4 · `UX` — côté serveur, toute violation de `VaultCreate` sort en `temMALFORMED` nu

Écart de dates hors bornes, dates manquantes, `VaultKind` inconnu, `Scale` sur XRP,
`DomainID` sans flag privé : le serveur répond « Malformed transaction. » sans
jamais nommer le champ. Les messages utiles — « RedemptionDate − SubscriptionDate
must be within [180, 946708560) seconds » — n'existent **que dans la validation
client de `xrpl.js`**. Un SDK tiers, ou un intégrateur qui signe à la main, n'a rien.
**Repro** : `probes/campaign-x.mjs` vs `probes/campaign-a.mjs` · **Sévérité** élevée · rippled 3.4.0-rc5

### 5 · `missing primitive` — aucune lecture côté XLS-66, et `LoanSet` est insimulable

`vault_info` existe. **Ni `loan_info`, ni `loan_broker_info`, ni `mpt_holders`.**
Reconstituer un vault impose une traversée à trois niveaux, chacun sur un
pseudo-compte différent :

```
vault_info → account_objects(vault.Account, type:'loan_broker')
           → account_objects(broker.Account, type:'loan')
```

Soit `2 + nb_brokers` appels — mesuré à **6 appels** pour 3 brokers et 3 prêts. Et
la liste des porteurs de parts n'existe pas du tout : il faut **rejouer tout
l'historique** du pseudo-compte via `account_tx` et reconstruire les soldes depuis
la meta. Enfin `simulate` refuse `LoanSet` sans co-signature (`temBAD_SIGNER`) :
**la transaction la plus difficile à construire est la seule qu'on ne peut pas
pré-vérifier.**

**Contournement** : `core.readVaultGraph()` et `core.holderMap()`. Le rejeu est
auto-vérifiant — la somme retombe exactement sur `shares.OutstandingAmount`.
**Repro** : `probes/campaign-h.mjs` · **Sévérité** élevée · rippled 3.4.0-rc5

### 6 · `documentation/tutorials` — `LendingProtocolV1_1` est actif et non documenté

`VaultKind`, `SubscriptionDate`, `RedemptionDate`, `LEVersion` existent sur le
ledger et sont connus du codec. **Aucune spec publiée ne les décrit** (PRs #570 et
#582 ouvertes). Le modèle en trois phases, l'obligation d'un vault closed-ended
pour créer un broker, la contrainte de fin de prêt : tout découvert par
essai-erreur.

| Envoyé | Reçu | Signifiait |
|---|---|---|
| `LoanBrokerSet` sur vault open-ended | `tecNO_PERMISSION` | V1_1 exige closed-ended |
| dernière échéance trop proche de `RedemptionDate` | `tecNO_PERMISSION` | marge réelle ~90 s en temps ledger |
| `StartDate` dans `LoanSet` | `Field found in disallowed location` | champ dérivé sur l'objet `Loan` |
| `Data` dans `LoanSet` | `tesSUCCESS` | **accepté puis jeté** |
| `Scale` sur vault XRP ou MPT | `temMALFORMED` | `Scale` n'existe que pour un IOU |

**Sévérité** élevée

### 7 · `UX` — trois drapeaux de `Batch` sur quatre livrent l'actif sans encaisser le prix

Même échange, jambe du prix volontairement impayable :

| Drapeau | Annoncé | Parts déplacées | Payé |
|---|---|---|---|
| `tfAllOrNothing` | `tesSUCCESS` | **0** | 0 |
| `tfOnlyOne` · `tfUntilFailure` · `tfIndependent` | `tesSUCCESS` | **300 000** | **0** |

C'est cohérent avec la sémantique de chaque mode, mais appliqué à un échange de
valeur, trois modes sur quatre font **livrer sans encaisser** — et les quatre
annoncent `tesSUCCESS`. Combiné à la friction n°2, l'erreur est **indétectable
sans réconciliation des soldes**.

À la décharge du protocole, l'oubli est impossible : `Flags: 0` → `temINVALID_FLAG`,
| `Error: No field \`flags\`` sur un `Batch` | `signMultiBatch` quand `Flags` manque — une `Error` brute, champ en minuscules, aucun remède suggéré |
est le **mauvais choix**, fait en connaissance de cause, sans moyen de le vérifier
après coup.

**Suggestion** : une mise en garde explicite dans XLS-56 pour les échanges de
valeur, et un helper de swap dans les SDK qui impose `tfAllOrNothing`.
**Repro** : `probes-marche/01-atomicite-et-rails.mjs` · **Sévérité** élevée · rippled 3.4.0-rc5

---

# Moyennes

### 8 · `UX` — `tecEXPIRED` a quatre sens, et la fenêtre de `LoanPay` ferme à l'échéance

Payer 5 s après `NextPaymentDueDate` → `tecEXPIRED` ; il faut deviner le flag
`tfLoanLatePayment`, qu'aucun message ne suggère. Le même `tecEXPIRED` signifie
aussi : dépôt hors Subscription, `LoanSet` en Redemption, credential expiré.
**Quatre causes, un code, indiscernables sans relire les dates du vault.**
**Repro** : `probes/campaign-f3.mjs`, `campaign-x.mjs` · **Sévérité** moyenne

### 9 · `documentation/tutorials` — trois champs « rate », trois sémantiques, zéro doc

Mesuré empiriquement : `InterestRate` est **annualisé** en 1/100 000 (10 XRP à
`100000` → 64 drops en 200 s). Les deux `CoverRate` sont des ratios instantanés en
1/100 000, mais la ponction au défaut vaut `principal × min × liq` — la
liquidation s'applique à la **tranche**, pas à la dette. `ManagementFeeRate` est borné à
[0, 10 000], et le plancher de `LoanBrokerCoverWithdraw` avec dette **n'a pas pu
être reconstruit** au drop près.
**Repro** : `probes/campaign-f3.mjs`, `campaign-g2.mjs`, `campaign-e.mjs` · **Sévérité** moyenne

### 10 · `UX` — la bascule de phase a 5 à 12 s de flou, en temps ledger

Le contrôle de phase utilise la close time du **ledger parent** : retard d'un
ledger, résolution 10 s. Un dépôt atterrissant 8 s **après** `SubscriptionDate`
passe encore ; un retrait au même instant autour de `RedemptionDate` échoue encore.
Codes asymétriques : dépôt hors fenêtre → `tecEXPIRED`, retrait trop tôt →
`tecTOO_SOON`. Rien ne l'indique, et c'est intestable sans tirer à ±2 s.
**Repro** : `probes/campaign-b2.mjs` · **Sévérité** moyenne

### 11 · `documentation/tutorials` — l'API v2 renomme `Amount` en `DeliverMax`

Un `Payment` relu par `account_tx` ou `tx` ne porte pas `Amount` mais `DeliverMax`.
Tout code lisant `tx.Amount` sur une transaction relue est **silencieusement
aveugle** : pas d'erreur, zéro résultat. C'est arrivé à notre lecteur d'historique
de prix, qui ne voyait aucun échange alors que la chaîne en contenait cinq.
**Contournement** : `core.payAmount(tx)` → `tx.Amount ?? tx.DeliverMax` · **Sévérité** moyenne

### 12 · `documentation/tutorials` — les MPT dans `Escrow` marchent, et rien ne le dit

Rails alternatifs au `Batch` : `CheckCreate` → `invalid SendMax`,
`PaymentChannelCreate` → `Amount must be a string`, `OfferCreate` →
**`temDISABLED`**. Mais **`EscrowCreate` avec un MPT → `tesSUCCESS`**, et le cycle
complet fonctionne : parts débitées à la création, `EscrowFinish` livre,
`EscrowCancel` restitue, et le gate du domaine est vérifié **à la création comme au
dénouement** (`tecNO_AUTH` si le credential est révoqué entre les deux). Deux
escrows partageant une `Condition` forment un échange atomique sans `Batch`.

**Asymétrie non documentée au passage** : recevoir ces parts par `Payment` exige
que le destinataire ait fait `MPTokenAuthorize` ; par `EscrowFinish`, non —
l'objet `MPToken` est créé d'office. C'est pour contourner la première que notre
Batch d'échange compte **trois jambes au lieu de deux**.

Enfin, `temDISABLED` sur le DEX signifie « implémenté, amendement éteint », pas
« non supporté » : un `temDISABLED` devrait **nommer l'amendement** en cause.
**Repro** : `probes-marche/03` et `04` · **Sévérité** moyenne

---

# Basses — codes et messages qui ne pointent pas la cause

*(les entrées écartées faute de place sont dans `probes/FRICTIONS.md` et `FRICTIONS-annexe.md`)*

Les quatre dernières lignes sont des frictions `client libraries` **revérifiées
ouvertes en beta.1**. Une cinquième, le tri des `Signers` en multisig, a été
retirée après revérification : `combineLoanSetCounterpartySigners` trie
correctement — le piège ne concerne que le montage à la main.

| Symptôme | Cause réelle |
|---|---|
| `LoanSet` à un emprunteur sans trustline | `tesSUCCESS`, trustline limite 0 **créée d'office** — aucun opt-in sur l'actif, contrairement au reste de XRPL |
| `tecKILLED` « No funds transferred and no offer created. » | message du DEX, sur un remboursement anticipé intégral — qui semble **impossible** par ailleurs |
| `tecPATH_DRY` | overflow d'émission de parts au-delà de 2⁶³−1 (IOU `Scale: 18`) |
| `AccountDelete` refusé | le message liste Escrows, PayChannels, RippleStates, Checks — **pas les MPToken**, la cause réelle |
| `vault_info` incomplet | `AssetsTotal`, `AssetsAvailable`, `LossUnrealized` **disparaissent quand ils valent 0** — tout client doit défendre par `?? '0'` |
| `PeriodicPayment: "5000017.836765632213"` | des **fractions de drop** dans un objet du ledger : tout parseur entier casse |
| `tefPAST_SEQ` inattendu | un code `tec` **consomme la séquence** ; lire `account_info` en `ledger_index: 'current'` |
| un refus aux *local checks* | remonté en **exception WebSocket**, pas dans `engine_result` : deux chemins de code pour « refusée », et un `submitAndWait` non protégé tombe |
| ```Error: No field `flags```` | `signMultiBatch` sur un `Batch` sans `Flags` — une `Error` brute, champ en minuscules, aucun remède suggéré |
| avertissement sur chaque `LoanSet` | deux `console.warn` non désactivables dans `sugar/autofill.js` (LoanSet et transaction sponsorisée) |
| `LoanBrokerSet` en update | le SDK exige `VaultID` alors que `LoanBrokerID` identifie déjà le broker |

---

# Une question, plus qu'une friction

`OfferCreate` avec un MPT en `TakerGets` répond **`temDISABLED`** — « cette
logique est actuellement désactivée ». Ce n'est pas « non supporté » : le code
existe, l'amendement dort. Tout indique **XLS-82 (MPTokensV2)**.

Ça décide de ce qu'on construit, d'où trois questions :

1. **Quel calendrier ?** Concevoir un marché secondaire de MPT aujourd'hui suppose
   de savoir si le support natif arrive dans trois mois ou dans deux ans.
2. **Le DEX natif connaîtra-t-il les Permissioned Domains ?** C'est la vraie
   question. Nos parts sont celles d'un vault **privé** : le transfert vers un
   non-membre rend `tecNO_AUTH`, et le contrôle s'applique au dépôt, au transfert
   direct et au dénouement d'un escrow. Si le carnet natif ignore les domaines, il
   ne pourra pas coter ces parts, et un marché pair-à-pair gardé sous contrainte de
   domaine garde tout son sens. S'il les connaît, notre brique devient inutile.
3. **`temDISABLED` devrait nommer l'amendement en cause** — le code seul oblige à
   deviner.

---

# Anti-frictions — ce qui nous a rassurés

- **Pas d'enfermement par design.** `SubscriptionDate` et `RedemptionDate` ne sont
  pas des champs de `VaultSet` : le propriétaire **ne peut pas** repousser la
  Redemption. Un membre exclu, expiré ou révoqué d'un domaine peut **toujours
  retirer**. Seul le gel IOU (`tecFROZEN`) bloque une sortie, et il est réversible.
- **Le pseudo-compte est étanche.** `Payment`, `EscrowCreate`, `CheckCreate`,
  `PaymentChannelCreate` → `tecNO_PERMISSION` ; transaction de vault dans un Batch
  → `temINVALID_INNER_BATCH` ; vault de parts de vault → `tecWRONG_ASSET`.
- **Aucune fuite d'arrondi** sur 145 aller-retours en XRP et en IOU (`Scale` 6 et 18).
- **Les `BatchSigners` couvrent les jambes internes** : un vendeur qui réécrit le
  prix après signature de l'acheteur est rejeté, et la séquence du vendeur interdit
  la double-vente.

---

*Les pistes de sécurité identifiées sont transmises de vive voix à un mentor avant
la présentation, conformément au règlement. Elles ne figurent pas dans ce document.*
