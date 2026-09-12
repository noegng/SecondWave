# Annexe — frictions du marché secondaire, version longue

**Track** 2 — Lending Protocol · **Flavour** Loaded (Permissioned Domains + Credentials)
**Environnement** Devnet public XRPL, `wss://s.devnet.rippletest.net:51233`, rippled 3.4.0-rc5,
amendements `LendingProtocolV1_1` et `fixCleanup3_4_0` actifs
**Lib** `xrpl.js@5.2.0-beta.1` · `ripple-binary-codec@2.11.0` · Node 24

> Le rapport remis au jury est `FEEDBACK.md` (3 pages). Ce fichier en est
> l'annexe : la version longue des frictions relevées côté règlement et marché
> secondaire, avec les repros complètes. Le pendant côté vault est
> `probes/FRICTIONS.md`.

---

## 1 · `signLoanSetByCounterparty` produit une signature invalide

**Catégorie** `client libraries` · **Sévérité** bloquant · **Lib** `xrpl.js@5.2.0-beta.1` (et 5.1.0)

Le helper signe le payload avec le préfixe historique `STX\0` alors que
`fixCleanup3_4_0` impose `CPT\0` (`0x43505400`) pour une co-signature simple et
`CPM\0` (`0x43504D00`) en multisig. Le serveur rejette :
`fails local checks: Counterparty: Invalid signature.`

**Conséquence** : aucun `LoanSet` n'est soumettable depuis le SDK publié.
Tout le flux XLS-66 est inatteignable — y compris avec l'exemple officiel
`_code-samples/lending-protocol/js/createLoan.js`.

Les bons encodeurs (`encodeForSigningCounterparty`, `encodeForMultisigningCounterparty`)
**existent déjà** dans `ripple-binary-codec@2.11.0`, avec le nom de l'amendement en
commentaire. Ils ne sont simplement jamais appelés.

**Pourquoi ça n'a pas été vu** : `packages/xrpl/.ci-config/xrpld.cfg` n'active pas
`fixCleanup3_4_0` — il s'arrête à `fixCleanup3_2_0`. Le helper n'est donc jamais
exercé dans le régime où il casse.

**Repro et correctif** : `PATCH-loanset-counterparty.md`, avec le diff proposé.
Vérifié côte à côte sur Devnet : `encodeForSigning` → échec local,
`encodeForSigningCounterparty` → `tesSUCCESS` et objet `Loan` créé.
**Même problème dans `xrpl-py`** (`counterparty_signer.py`), qui nécessite d'abord
les deux préfixes dans son codec.

---

## 2 · `Batch` renvoie `tesSUCCESS` sans rien appliquer, et ne dit pas pourquoi

**Catégorie** `UX` · **Sévérité** élevée · **Lib** rippled

Un `Batch` `tfAllOrNothing` dont les jambes échouent toutes est validé avec
`tesSUCCESS`. Sa meta ne contient **qu'un seul nœud** : la ponction de frais.
Le `BatchExecutions` annoncé par XLS-56 est absent.

Autrement dit : **le code de retour d'un Batch ne porte aucune information sur
son effet**. Le seul moyen fiable de savoir s'il a marché est de comparer les
soldes avant et après.

**Contournement** (`packages/settlement`, couche EVIDENCE) : les jambes internes
sont des transactions à part entière, dans le même ledger, avec leur propre hash.
On les récupère par `account_tx` sur la plage `[ledgerIndex, ledgerIndex]` pour
chaque compte impliqué — c'est le `BatchExecutions` reconstruit à la main.

**Repro** : `node fixtures/test-settlement.mjs`, cas 3.

---

## 2bis · Trois drapeaux de `Batch` sur quatre laissent partir l'actif sans le paiement

**Catégorie** `UX` · **Sévérité** élevée · **Lib** rippled

Le même échange — parts contre XRP, jambe du prix volontairement impayable —
rejoué sous chaque drapeau :

| Drapeau | Résultat annoncé | Parts déplacées | Prix payé |
|---|---|---|---|
| `tfAllOrNothing` | `tesSUCCESS` | **0** | 0 |
| `tfOnlyOne` | `tesSUCCESS` | **300 000** | **0** |
| `tfUntilFailure` | `tesSUCCESS` | **300 000** | **0** |
| `tfIndependent` | `tesSUCCESS` | **300 000** | **0** |

C'est cohérent avec la sémantique de chaque mode. Mais appliqué à un échange de
valeur, trois modes sur quatre font **livrer sans encaisser**, et les quatre
annoncent `tesSUCCESS`. Combiné à la friction n°2 — la meta ne montre rien —
une erreur de drapeau est **indétectable sans réconciliation des soldes**.

À la décharge du protocole : **oublier le drapeau n'est pas possible.**
`Flags: 0` est refusé par `temINVALID_FLAG`, et le SDK refuse même de co-signer
un Batch sans champ `Flags` (`Error: No field \`flags\`` — une `Error` brute, au
message non actionnable et au nom de champ en minuscules). Le risque n'est donc
pas l'oubli, c'est **le mauvais choix**, fait en connaissance de cause par un
développeur qui n'a aucun moyen de vérifier son effet après coup.

**Suggestion** : que la documentation de XLS-56 comporte une mise en garde
explicite pour les échanges de valeur, et que les SDK exposent un helper de swap
qui impose `tfAllOrNothing`.

**Repro** : `node probes-marche/01-atomicite-et-rails.mjs`, sonde 4.

---

## 3 · L'API v2 renomme `Amount` en `DeliverMax` sans le signaler

**Catégorie** `documentation/tutorials` · **Sévérité** moyenne · **Lib** rippled API v2

Un `Payment` relu via `account_tx` ou `tx` ne porte pas `Amount` mais `DeliverMax` :

```json
{ "TransactionType": "Payment",
  "DeliverMax": { "mpt_issuance_id": "0000…", "value": "6250000" } }
```

Tout code qui écrit `tx.Amount` sur une transaction relue est **silencieusement
aveugle** : pas d'erreur, juste zéro résultat. C'est exactement ce qui est arrivé
à notre lecteur d'historique de prix, qui ne voyait aucun échange alors que la
chaîne en contenait.

**Contournement** : `core.payAmount(tx)` → `tx.Amount ?? tx.DeliverMax`.

---

## 4 · Aucune primitive de lecture côté XLS-66

**Catégorie** `missing primitive` · **Sévérité** élevée · **Lib** rippled

`vault_info` existe. **Il n'existe ni `loan_info`, ni `loan_broker_info`, ni
`mpt_holders`.** Pour obtenir l'état d'un vault il faut une traversée à trois
niveaux, chacun sur un pseudo-compte différent :

```
vault_info(vaultId)
  → account_objects(vault.Account, type:'loan_broker')
    → account_objects(broker.Account, type:'loan')
```

Et pour savoir **qui détient les parts**, il n'y a aucune commande : il faut
rejouer tout l'historique du pseudo-compte du vault via `account_tx` et
reconstruire les soldes depuis la meta.

**Contournement** : `core.readVaultGraph()` et `core.holderMap()`. Le rejeu est
auto-vérifiant — la somme des soldes reconstruits retombe exactement sur
`shares.OutstandingAmount`, ce qui donne gratuitement un contrôle d'intégrité.

**Ordre de grandeur** : reconstituer un vault à 2 brokers et 2 prêts avec sa
liste de détenteurs demande **6 appels RPC**, dont un parcours paginé complet.

---

## 5 · `LendingProtocolV1_1` est actif et non documenté

**Catégorie** `documentation/tutorials` · **Sévérité** élevée

`VaultKind`, `SubscriptionDate`, `RedemptionDate` et `LEVersion` existent sur le
ledger du Devnet et sont connus du codec. **Aucune spec publiée ne les décrit** —
les PRs #570 et #582 sont encore ouvertes. Le modèle en trois phases, la
contrainte « dernière échéance avant `RedemptionDate` », l'obligation d'un vault
closed-ended pour créer un broker : tout cela a été découvert par essai-erreur.

Conséquences directes rencontrées :

| Ce qu'on a envoyé | Ce qu'on a reçu | Ce que ça voulait dire |
|---|---|---|
| `LoanBrokerSet` sur vault open-ended | `tecNO_PERMISSION` | V1_1 exige un vault closed-ended |
| `LoanSet` dont la dernière échéance dépasse `RedemptionDate` | `tecEXPIRED` | il faut ~60 s de marge |
| `StartDate` dans `LoanSet` | `Field found in disallowed location` | le champ est dérivé sur l'objet `Loan` |
| `Data` dans `LoanSet` | `tesSUCCESS` | accepté par la validation, puis **jeté** |
| `Scale` sur un vault XRP ou MPT | `temMALFORMED` | `Scale` n'existe que pour un IOU |

---

## 6 · Messages d'erreur non actionnables

**Catégorie** `UX` · **Sévérité** moyenne

| Message | Cause réelle |
|---|---|
| `temARRAY_EMPTY` sur un `Batch` | le tableau n'est pas vide : il a **moins de 2 entrées** (`Batch.cpp` l.231) |
| `telNETWORK_ID_MAKES_TX_NON_CANONICAL` | `NetworkID` doit être **omis**, pas corrigé, quand `network_id ≤ 1024` |
| `tecTOO_SOON` / `tecEXPIRED` | opaques : ils ne disent pas quelle phase est en cours ni jusqu'à quand |
| `tecNO_AUTH` sur un transfert de parts | peut vouloir dire « non membre du domaine » **ou** « pas encore autorisé le MPT » — deux causes très différentes, même code |

Ce dernier point a produit un **faux négatif** dans notre preflight : simuler le
transfert de parts vers un acheteur éligible mais non encore autorisé renvoie
`tecNO_AUTH`, alors que le Batch l'autorisera en première jambe. Le contournement
consiste à simuler l'autorisation plutôt que le transfert quand l'acheteur n'a
pas encore d'objet `MPToken`.

---

## 6bis · Les MPT dans `Escrow` fonctionnent et ne sont documentés nulle part

**Catégorie** `documentation/tutorials` · **Sévérité** moyenne

En cherchant des rails de règlement alternatifs au `Batch`, on a testé les quatre
candidats. Trois sont fermés, et leurs messages sont clairs :

| Rail | Résultat |
|---|---|
| `CheckCreate` avec un MPT en `SendMax` | `CheckCreate: invalid SendMax` |
| `PaymentChannelCreate` avec un MPT | `Amount must be a string` |
| `OfferCreate` sur le DEX avec un MPT | **`temDISABLED`** |
| **`EscrowCreate` avec un MPT** | **`tesSUCCESS`** |

Le quatrième marche de bout en bout, et **rien ne le dit** :

- `EscrowCreate` avec des parts de vault en `Amount` → `tesSUCCESS`
- les parts sont **débitées du solde `MPToken` dès la création**
- `EscrowFinish` **livre réellement** les parts au destinataire
- le gate du domaine **tient** : un escrow vers un non-membre rend `tecNO_AUTH`
- une condition `PreimageSha256` est acceptée sur un escrow de MPT
- la même condition passe sur un escrow d'XRP en sens inverse

La dernière ligne est celle qui compte : **deux escrows liés par la même condition
forment un échange atomique sans `Batch`**, avec un avantage que le Batch n'a pas —
l'engagement du vendeur est un **objet du ledger**, donc une offre de vente
publiquement vérifiable, et non une signature qui dort hors chaîne.

C'est une capacité utile et elle est invisible : la documentation d'`Escrow` ne
mentionne pas les MPT, et rien dans XLS-33 ne renvoie vers `Escrow`.

**Repro** : `node probes-marche/03-escrow-et-drapeau-par-defaut.mjs`, sonde B.

---

## 6ter · `temDISABLED` sur le DEX : le code existe, l'amendement dort

**Catégorie** `documentation/tutorials` · **Sévérité** faible (mais structurante)

`OfferCreate` avec un MPT en `TakerGets` ne rend pas `temMALFORMED` mais
**`temDISABLED` — « The transaction requires logic that is currently disabled. »**

La nuance est importante : ce n'est pas « non supporté », c'est « implémenté et
désactivé ». Un développeur qui conçoit un marché secondaire aujourd'hui doit
savoir que le support natif arrive, et à peu près quand — sans quoi il construit
une infrastructure P2P qui sera obsolète à l'activation de l'amendement.

**Demande** : que le statut et le calendrier de `MPTokensV2` (XLS-82) soient
publics, et qu'un `temDISABLED` indique **quel** amendement est en cause.

---

## 6quater · Deux chemins de livraison, deux exigences d'autorisation

**Catégorie** `protocol` · **Sévérité** moyenne

L'issuance des parts d'un vault privé porte `lsfMPTRequireAuth` (flags 60). Pour
recevoir ces parts :

| Chemin | Le destinataire doit-il avoir fait `MPTokenAuthorize` ? |
|---|---|
| `Payment` | **oui** — sinon la jambe échoue |
| `EscrowFinish` | **non** — l'objet `MPToken` est créé au dénouement |

Mesuré : un compte crédentialisé mais n'ayant **jamais** appelé `MPTokenAuthorize`
reçoit 200 000 parts par `EscrowFinish` en `tesSUCCESS`.

Le contrôle de domaine, lui, s'applique dans les deux cas — et l'escrow le
réévalue **au dénouement**, pas seulement à la création : révoquer le credential
du destinataire après `EscrowCreate` fait échouer `EscrowFinish` en `tecNO_AUTH`.
Ce point-là est sain et rassurant.

Reste l'asymétrie sur l'opt-in du détenteur. Elle n'est écrite nulle part, et elle
a un coût concret : c'est pour la contourner que notre Batch d'échange compte
**trois jambes au lieu de deux**, la première n'étant qu'un `MPTokenAuthorize`
préalable. Un développeur qui découvre `EscrowFinish` après coup a écrit du code
pour rien.

**Repro** : `node probes-marche/04-escrow-gate-au-denouement.mjs`, cas A et B.

---

## 7 · Avertissement SDK non désactivable sur chaque `LoanSet`

**Catégorie** `client libraries` · **Sévérité** faible · **Lib** `xrpl.js@5.2.0-beta.1`

`autofill` écrit sur la sortie standard, à chaque appel :

```
For LoanSet transaction the auto calculated Fee accounts for total number of
signers the counterparty has to avoid transaction failure.
```

Pas de niveau de log, pas d'option pour le taire. Six prêts créés = six lignes
parasites au milieu de la sortie applicative.

---

## 8 · Un `tec` consomme la séquence

**Catégorie** `documentation/tutorials` · **Sévérité** moyenne

Un code `tec` est « appliqué » : il consomme la séquence du compte tout en ayant
échoué. Lire `account_info` en `ledger_index: 'validated'` juste après donne une
séquence périmée, et la transaction suivante meurt en `tefPAST_SEQ`.

**Contournement** : toujours lire en `ledger_index: 'current'`. Et comme
`autofill` lit la séquence au moment de l'appel, deux transactions du même compte
lancées en parallèle reçoivent la même — `core.submit` sérialise donc par compte.

---

## Pistes de sécurité

Traitées séparément, **à transmettre de vive voix à un mentor avant le pitch**
conformément au règlement. Elles ne figurent pas dans ce fichier.
