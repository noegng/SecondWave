# SecondWave — le dossier complet

*Tout ce qu'il faut savoir sur le projet : le problème, le vocabulaire, les normes
employées, l'architecture du code, et ce qu'on a mesuré. Écrit pour être lu d'une
traite, sans rien connaître au départ.*

---

# 1 · Le problème

## En une phrase

XRP Ledger sait désormais faire des **fonds de crédit privé**. Mais quand on y met
son argent, **on ne peut plus le récupérer avant la date de fin** — et il n'existe
aucun moyen de céder sa place à quelqu'un d'autre.

## En détail

La norme **XLS-65** définit un *vault* : un pot commun où plusieurs personnes
déposent le même actif, et qui prête cet argent. Chaque déposant reçoit des
**parts** proportionnelles à son dépôt.

Depuis l'amendement `LendingProtocolV1_1`, ces vaults peuvent être
**closed-ended** — à horizon fermé — et fonctionnent alors en **trois phases** :

| Phase | Ce qui est permis |
|---|---|
| **Subscription** | on dépose, on retire librement. Prêter est interdit. |
| **Investment** | on prête. **Déposer et retirer sont bloqués.** |
| **Redemption** | on retire son capital plus le rendement. Plus de nouveau prêt. |

C'est un modèle sain et classique : le gérant a besoin de savoir de combien il
dispose pour prêter à échéance fixe. Si les déposants pouvaient partir au milieu,
il devrait garder du cash improductif.

**Le prix à payer, c'est le déposant.** Pendant toute la phase Investment, son
capital est enfermé. Un appel de marge, un changement de mandat, un besoin de
trésorerie — il n'a aucune issue. `VaultWithdraw` répond `tecTOO_SOON`, et
c'est tout.

## La brèche

Les parts ne sont pas une simple ligne comptable : ce sont des **jetons**, au sens
de la norme XLS-33. Et un jeton, **ça se transfère**.

La sortie existe donc déjà. Elle n'est simplement pas outillée : *vendre ses parts
à quelqu'un d'autre*. C'est exactement ce que fait le monde réel pour le private
equity et la dette privée — on appelle ça un **marché secondaire**.

---

# 2 · La solution

**SecondWave est un marché secondaire de positions de vault verrouillées, avec un
analyste de risque intégré.**

Trois briques :

1. **Un carnet d'offres.** Un déposant enfermé propose ses parts à un prix. Un
   autre membre du fonds les rachète.
2. **Un règlement atomique.** Les parts et l'argent changent de main **ensemble ou
   pas du tout** — sinon l'un des deux se fait dépouiller.
3. **Un analyste.** Le vendeur brade toujours un peu. Mais **pourquoi** brade-t-il ?
   Parce qu'il a besoin de cash — ou parce qu'il sait que le fonds va mal ? C'est
   toute la question, et c'est ce que l'analyste répond.

## Le cœur du sujet : deux décotes qui se ressemblent

Une part vaut théoriquement `NAV` — la valeur nette du fonds divisée par le nombre
de parts. Une offre à 88 % de la NAV affiche donc **12 % de décote**. Mais :

| | Décote de **liquidité** | Décote de **détresse** |
|---|---|---|
| Ce qui se passe | le fonds va bien, le vendeur a besoin de cash | le fonds va mal et ça ne se voit pas encore |
| Pour l'acheteur | **une opportunité** | **un piège** |
| Prix affiché | *identique* | *identique* |

**Rien sur la chaîne ne les distingue.** C'est la raison d'être de l'analyste, et
c'est le moment fort de la démonstration : deux offres au même prix, deux verdicts
opposés, et la raison de chacun.

Le piège le plus vicieux qu'on a trouvé : un prêt dont l'échéance **et** le délai
de grâce sont dépassés, mais que le courtier n'a **pas déclaré en défaut**. Rien
ne l'y oblige. La NAV reste donc intacte, l'offre paraît saine, et la perte
tombera plus tard — sur l'acheteur.

---

# 3 · Le vocabulaire

## Le vocabulaire de la finance

**Vault** — le pot commun. En français : un fonds. Il contient un seul type
d'actif (XRP, ou un dollar tokenisé, etc.).

**Part** (*share*) — ce qu'on reçoit en déposant. Détenir 25 % des parts, c'est
avoir droit à 25 % de ce que vaut le fonds.

**NAV** (*Net Asset Value*) — la valeur d'une part. Actifs totaux moins pertes
constatées, divisé par le nombre de parts en circulation. C'est la référence par
rapport à laquelle on mesure une décote.

**Décote** (*discount*) — vendre en dessous de la NAV. 0,88 pour une NAV de 1,00
= 12 % de décote.

**Illiquidité** — l'impossibilité de transformer un actif en cash rapidement.
C'est ce qu'on vend sur ce marché : le vendeur paie une décote pour obtenir de la
liquidité tout de suite.

**Crédit privé** — prêter à des entreprises en dehors des banques et des marchés
cotés. Peu de prêts, gros montants, contreparties identifiées, pas de garantie
saisissable — l'analyse de crédit remplace le collatéral. **C'est le modèle de
XLS-66**, et c'est important : ce n'est pas de la DeFi anonyme sur-collatéralisée.

**Courtier** (*LoanBroker*) — l'intermédiaire entre les déposants et les
emprunteurs. Il sélectionne les dossiers, et surtout il engage son propre argent
en première ligne.

**First-loss capital** (*cover*) — l'argent que le courtier dépose et qui absorbe
**les premières pertes** avant que les déposants ne soient touchés. C'est sa peau
dans le jeu. On a mesuré qu'il peut légalement être **nul**.

**Défaut** — l'emprunteur ne rembourse pas, et quelqu'un le constate officiellement.

**Impairment** — constater une perte *probable* avant qu'elle soit certaine. Le
fonds inscrit une `LossUnrealized` et la NAV baisse, sans que le prêt soit encore
en défaut.

## Le vocabulaire XRP Ledger

**Ledger** — le registre. Une nouvelle version est close toutes les 3 à 5
secondes ; chacune porte un numéro.

**Transaction** — la seule façon de changer quoi que ce soit. Elle a un `Account`
(qui la signe et paie les frais), un `TransactionType`, et des champs propres à ce
type.

**Objet du ledger** (*ledger entry*) — ce qui existe dans le registre : un compte,
un vault, un prêt, un jeton détenu. Les transactions créent, modifient et
suppriment ces objets.

**Drop** — la plus petite unité d'XRP. 1 XRP = 1 000 000 drops. Tous les montants
XRP se manipulent en drops.

**Réserve** (*reserve*) — XRPL immobilise une petite somme par objet qu'on possède,
pour éviter que le registre enfle gratuitement. Aujourd'hui : 1 XRP de base par
compte, **+0,2 XRP par objet**. Détenir des parts consomme donc 0,2 XRP bloqués.

**Séquence** (*Sequence*) — le compteur de transactions d'un compte. Chacune porte
le numéro suivant, ce qui interdit le rejeu et impose un ordre strict. **Deux
transactions du même compte ne peuvent pas partir en parallèle.**

**Meta** (*metadata*) — le compte rendu attaché à chaque transaction validée :
la liste exacte des objets créés, modifiés ou supprimés. **C'est la seule source
de vérité** sur ce qui s'est réellement passé.

**Codes de retour** — trois familles à ne pas confondre :

| Préfixe | Sens | Inscrit au ledger ? | Frais ? |
|---|---|---|---|
| `tes` | succès (`tesSUCCESS`) | oui | oui |
| `tec` | échec **appliqué** | oui | **oui** |
| `tem` / `tef` / `tel` | malformée, rejetée avant application | non | non |

Un `tec` est le piège classique : la transaction a échoué **mais elle consomme la
séquence et les frais**.

**Amendement** (*amendment*) — une modification du protocole, activée par vote des
validateurs. Tant qu'elle n'est pas active, l'ancien comportement reste vrai. Les
deux qui nous concernent : `LendingProtocolV1_1` (les vaults à trois phases) et
`fixCleanup3_4_0` (le changement de préfixe de signature qui a cassé le SDK).

**Pseudo-compte** — un compte que **personne ne contrôle**, créé automatiquement
par le protocole pour détenir les actifs d'un vault ou d'un courtier. Il a une
adresse `r…` comme les autres, mais aucune clé privée n'existe pour lui. C'est le
protocole seul qui bouge ce qu'il contient. On a vérifié qu'il est étanche : lui
envoyer un paiement direct répond `tecNO_PERMISSION`.

**Flags** — un seul nombre entier dont **chaque bit** allume une option. Écrits
`tf…` pour une transaction, `lsf…` pour un objet. Plutôt que quinze champs
oui/non, un nombre.

**SDK** — la bibliothèque qui permet de parler à la chaîne depuis son code. Ici
`xrpl.js`, empilée sur `ripple-binary-codec` (JSON ↔ octets) et `ripple-keypairs`
(la cryptographie).

**Local checks** — le premier filtre du serveur : la forme, les signatures. Un
refus à ce stade signifie « je n'ai même pas essayé » — rien n'est inscrit, rien
n'est facturé. À distinguer d'un `tec`, qui veut dire « j'ai essayé, ça a raté,
tu paies quand même ».

## Le vocabulaire du projet

**Preflight** — notre couche de vérification *avant* d'envoyer : le vendeur a-t-il
les parts, l'acheteur est-il éligible et solvable, les parts sont-elles
transférables. Aucun échange ne part s'il doit échouer.

**Evidence** — notre reconstruction du compte rendu manquant d'un `Batch`
(voir §7).

**Réconciliation** — la comparaison des soldes avant et après. **La seule preuve**
qu'un échange a réellement eu lieu.

---

# 4 · « Quel smart contract ? » — aucun, et c'est le sujet

C'est la question qu'on pose toujours, et la réponse surprend : **il n'y a pas de
smart contract dans ce projet, parce que XRP Ledger n'en a pas** au sens
d'Ethereum.

Sur Ethereum, on déploie du code qui vit sur la chaîne et qu'on appelle. Sur XRPL,
**les fonctionnalités sont dans le protocole lui-même** : un vault n'est pas un
contrat déployé, c'est un *type d'objet natif*, avec ses transactions dédiées,
implémenté en C++ dans le serveur `rippled`.

Les conséquences sont concrètes :

| | Contrat déployé (Ethereum) | Objet natif (XRPL) |
|---|---|---|
| Qui écrit la logique | n'importe qui | les mainteneurs du protocole |
| Bugs possibles | dans chaque contrat | dans le protocole, donc audité une fois |
| Coût | gaz à l'exécution | frais fixes, quelques dizaines de drops |
| Souplesse | totale | **limitée à ce qui existe** |
| Évolution | on redéploie | **il faut un amendement et un vote** |

Ce dernier point explique tout notre travail. **On ne peut pas écrire le marché
secondaire qui manque** — on doit le composer avec les briques existantes. D'où
notre carnet d'offres hors chaîne, et l'usage du `Batch` pour obtenir
l'atomicité qu'aucun objet natif ne nous donne.

> *Nuance : XRPL introduit les Smart Escrows, du WebAssembly attaché à une mise
> sous séquestre. On les a testés — hors sujet pour nous, mais ce n'est plus
> tout à fait « zéro programmabilité ».*

---

# 5 · Les normes XLS employées

Une **XLS** (*XRP Ledger Standard*) est une proposition d'évolution du protocole,
numérotée. Notre projet en combine **six**.

| Norme | Nom | Ce qu'elle nous apporte |
|---|---|---|
| **XLS-65** | Single Asset Vault | le fonds lui-même : dépôts, parts, phases |
| **XLS-66** | Lending Protocol | les prêts, les courtiers, le first-loss capital |
| **XLS-33** | Multi-Purpose Tokens | **les parts sont un MPT** — c'est ce qui les rend cessibles |
| **XLS-56** | Batch | plusieurs transactions en une seule, atomiquement |
| **XLS-70** | Credentials | l'attestation KYC : un émetteur certifie un compte |
| **XLS-80** | Permissioned Domains | le club fermé : seuls les porteurs du bon credential entrent |

## Comment elles s'emboîtent

**XLS-65 + XLS-66** donnent le fonds de crédit. Le vault détient l'argent, le
courtier prête, les emprunteurs remboursent, le rendement remonte aux déposants.

**XLS-33** fait des parts un vrai jeton. Sans ça, aucun marché secondaire n'est
possible — et c'est vérifiable : un vault créé avec le drapeau
`tfVaultShareNonTransferable` produit des parts qu'on ne peut **jamais** revendre.

**XLS-70 + XLS-80** font du fonds un **club fermé**. L'émetteur délivre un
credential à chaque membre vérifié, le domaine liste les credentials acceptés, le
vault pointe vers le domaine. On a mesuré que le contrôle s'applique **partout** :
au dépôt, au transfert de parts, et même au dénouement d'une mise sous séquestre.

C'est ce qui rend le projet crédible pour du crédit privé : on sait **qui** est en
face. Un non-membre reçoit `tecNO_AUTH`, sans exception.

**XLS-56** fournit l'atomicité de l'échange.

## Pourquoi notre carnet est hors chaîne — et jusqu'à quand

C'est la question qu'on nous posera, et la réponse n'est pas un arbitrage
d'architecture. **On a essayé le carnet natif, et la chaîne a dit non.**

XRP Ledger a un carnet d'ordres intégré au protocole — le **DEX**. Une transaction
`OfferCreate` y dépose un objet `Offer` qui **reste dans le ledger** et que le
protocole **apparie tout seul** : dès qu'un ordre inverse arrive, les deux se
croisent sans que les parties se soient jamais parlé. C'est exactement ce qu'il
nous faudrait.

```
OfferCreate  TakerGets: { mpt_issuance_id: … }
  → temDISABLED — « the transaction requires logic that is currently disabled »
```

La nuance du code compte. Ce n'est pas `temMALFORMED`, qui voudrait dire « ta
transaction est mal formée ». `temDISABLED` veut dire **« le code existe,
l'amendement est éteint »**. Tout indique **XLS-82 — MPTokensV2**, même si rien
de public ne le confirme.

Notre carnet hors chaîne est donc un **contournement mesuré**, pas une préférence.

### Et l'escrow ne comble pas le trou

On pourrait croire qu'à défaut de DEX, un escrow ferait office d'offre publique.
Non : **`Destination` est un champ obligatoire**, on l'a vérifié. Un escrow est un
engagement *bilatéral*, envers quelqu'un de nommé d'avance. Impossible de publier
une offre « au porteur ».

C'est ça, la vraie différence entre les deux mondes — pas le transfert des parts,
qui marche déjà, mais **la publication sans destinataire**.

### Le jour où l'amendement s'active

Trois cas, et il faut être honnête sur les trois.

**Pour un vault public**, notre carnet devient largement redondant. Un carnet natif
fait mieux : découverte gratuite, appariement automatique, exécutions partielles
sans surcoût — alors que chez nous, chaque fraction paie son propre `Batch` et le
coût est **linéaire**, c'est mesuré.

**Pour un vault privé, on ne sait pas.** Il y a une tension logique qu'on peut
poser précisément : un carnet d'ordres est **sans permission** — il apparie deux
ordres sans rien savoir de qui les a posés. Or nos parts sont gatées, et un
transfert vers un non-membre rend `tecNO_AUTH`. Un DEX qui accepterait les MPT
tout en restant sans permission apparierait donc des ordres dont le règlement
serait ensuite refusé par le ledger. Ça ne tient pas en l'état.

Comment cette tension sera résolue, **nous l'ignorons**. Au moins quatre issues
sont possibles : le DEX refuse de coter un MPT portant `RequireAuth` ; il le cote
et les appariements échouent ; il devient conscient des domaines ; ou la norme MPT
embarque elle-même le filtrage. C'est **intestable** tant que l'amendement dort.

D'où notre question aux mentors, formulée comme une question et pas comme une
thèse : **le DEX natif connaîtra-t-il les Permissioned Domains ?**

**Ce qui survit dans tous les cas** : l'analyste. Un carnet natif afficherait des
prix ; il ne dirait jamais si une décote de 12 % est une opportunité ou un piège.
Le DEX résout la **rencontre**, pas le **jugement**.

> « Le carnet natif refuse les MPT — le code est là, l'amendement dort. On a donc
> construit la rencontre hors chaîne et gardé le règlement entièrement on-chain.
> Le jour où l'amendement s'active, notre carnet devient inutile pour un vault
> public. Pour un vault privé, ça dépend de si le DEX connaît les Permissioned
> Domains — et c'est notre question pour vous. Dans les deux cas, l'analyste
> reste. »

## Ce qu'on a exploré sans l'intégrer

**Escrow** — la mise sous séquestre native. On a découvert qu'elle **accepte les
MPT**, ce qui n'est documenté nulle part, et que le cycle complet fonctionne :
les parts sont bloquées à la création, `EscrowFinish` les livre, `EscrowCancel`
les restitue, et le contrôle de domaine s'applique **à la création comme à la
livraison**. Deux séquestres liés par la même condition cryptographique forment
même un échange atomique **sans `Batch`**. Piste solide pour une v2, détaillée
dans `probes-marche/RESULTATS.md`.

---

# 6 · L'inventaire technique

## Les 18 types de transaction utilisés

| Domaine | Transactions |
|---|---|
| **Identité** (XLS-70/80) | `CredentialCreate`, `CredentialAccept`, `PermissionedDomainSet` |
| **Vault** (XLS-65) | `VaultCreate`, `VaultDeposit`, `VaultWithdraw` |
| **Prêt** (XLS-66) | `LoanBrokerSet`, `LoanBrokerCoverDeposit`, `LoanBrokerCoverWithdraw`, `LoanSet`, `LoanPay`, `LoanManage`, `LoanDelete` |
| **Jetons** (XLS-33) | `MPTokenAuthorize`, `Payment` *(avec un montant MPT)* |
| **Marché** (XLS-56) | `Batch` |
| **Divers** | `TrustSet` *(vaults en IOU)*, `AccountSet` |

## Les 9 commandes de lecture

`vault_info` · `account_info` · `account_objects` · `account_tx` · `ledger_entry` ·
`ledger` · `tx` · `submit` · `simulate`

**Une seule commande existe pour lire le côté prêt** : `vault_info`. Ni
`loan_info`, ni `loan_broker_info`, ni de liste des détenteurs de parts. Tout le
reste, on le reconstruit — c'est une part importante de notre travail, et l'une de
nos frictions majeures.

---

# 7 · L'architecture du code

Un monorepo npm en cinq paquets, chacun avec une responsabilité nette.

```
packages/core        lire la chaîne, envoyer des transactions
packages/vault       le cycle de vie XLS-65/66
packages/settlement  l'échange atomique
packages/orderbook   le carnet d'offres
packages/analyst     la notation du risque          (Noé)
apps/cli             la démonstration en terminal
fixtures/            le générateur de monde de test
probes/              les sondes d'exploration du protocole
```

## `core` — lire et écrire

**`readVaultGraph(vaultId)`** est la pièce centrale. Faute de commande dédiée, il
faut descendre **trois niveaux**, chacun sur un pseudo-compte différent :

```
vault_info(vaultId)
  → account_objects(pseudo-compte du vault,   type: 'loan_broker')
    → account_objects(pseudo-compte du courtier, type: 'loan')
```

**`holderMap(vault)`** répond à « qui détient les parts ? ». Aucune commande ne le
dit. On **rejoue tout l'historique** du pseudo-compte via `account_tx` et on
reconstruit les soldes depuis la meta de chaque transaction.

L'astuce qui rend ça fiable : on ne lit **que la meta**, jamais les champs de la
transaction. Chaque nœud `MPToken` de la meta donne le solde absolu après coup,
quel que soit le type de transaction — dépôt, retrait, transfert. Et le résultat
est **auto-vérifiant** : la somme doit retomber exactement sur
`shares.OutstandingAmount`. Elle y retombe.

**`submit()`** ajoute une **file d'attente par compte**. Le SDK lit la séquence au
moment de l'appel ; deux transactions du même compte lancées en parallèle
reçoivent la même et la seconde meurt en `tefPAST_SEQ`. La sérialisation est donc
portée ici, ce qui laisse paralléliser librement entre comptes différents.

## `vault` — le cycle de vie, avec ses règles encodées

Chaque transaction XLS-65/66, enveloppée avec **sa validation locale avant le
réseau**. Toutes les règles qu'on a découvertes par essai-erreur sont encodées ici,
avec un message qui dit quoi corriger — là où le protocole renvoie un
`temMALFORMED` nu.

Exemples de règles écrites nulle part et désormais dans le code :
`60 ≤ GracePeriod ≤ PaymentInterval` · l'écart Subscription/Redemption dans ses
bornes · la dernière échéance avant la Redemption · `Scale` interdit hors IOU ·
les deux taux de cover nuls ou non nuls ensemble, et immuables.

## `settlement` — l'échange, et surtout sa preuve

C'est le paquet le plus intéressant, parce que le problème n'est pas de faire
l'échange : **c'est de savoir s'il a eu lieu.**

Un `Batch` renvoie `tesSUCCESS` qu'il ait tout appliqué ou rien du tout — ce qui
se défend, puisque `tfAllOrNothing` promet précisément cet invariant. Le problème
est que **les deux issues sont indiscernables** : sur huit `Batch` rejoués, cinq
ayant livré des parts et trois n'ayant rien fait, une seule combinaison apparaît —
`tesSUCCESS` et **un seul nœud de meta**, la ponction de frais. Le compte rendu
détaillé promis par XLS-56, le `BatchExecutions`, est **absent**.

D'où trois couches :

**1. Preflight** — sept vérifications avant de dépenser un drop : parts
transférables, acheteur éligible au domaine, soldes suffisants des deux côtés,
autorisation déjà posée ou non, plus une simulation de la jambe critique.

> Un piège qu'on a dû contourner : simuler le transfert de parts vers un acheteur
> éligible mais pas encore autorisé renvoie `tecNO_AUTH` — un **faux négatif**,
> puisque le `Batch` l'autorisera en première jambe. On simule donc l'autorisation
> elle-même dans ce cas.

**2. Evidence** — la reconstruction du compte rendu manquant. Les jambes internes
sont en réalité des **transactions à part entière**, dans le même ledger, avec
leur propre empreinte. On les retrouve par `account_tx` sur la plage
`[ledgerIndex, ledgerIndex]` de chaque compte impliqué.

**3. Réconciliation** — les soldes avant et après. Si rien n'a bougé, le résultat
est marqué `silent-failure`, quoi qu'ait annoncé le `Batch`.

## `orderbook` — le carnet

Hors chaîne, et c'est un choix : une offre n'engage rien tant qu'elle n'est pas
acceptée, et XLS-65 n'offre aucune primitive de mise en vente.

Deux choses qu'il apporte au-delà d'une simple liste :

- **il n'affiche à un acheteur que ce qu'il peut réellement recevoir** — et
  quand une offre est inaccessible, il dit *pourquoi* plutôt que de la masquer ;
- **il relit les prix passés sur la chaîne**. Rien n'enregistre un « prix », mais
  un échange laisse un paiement de parts et un paiement d'XRP dans le même ledger.
  On les recolle. **L'historique des prix est donc entièrement on-chain**, sans
  aucun registre privé.

## `analyst` — la notation (Noé)

Consomme le graphe normalisé et rend une notation **AAA → D** avec ses raisons.
Sa décision clé : distinguer **décote de liquidité** de **décote de détresse**.

Son signal le plus fort — *« prêt en retard latent : la NAV est encore intacte, le
courtier n'a pas déclaré l'impairment »* — correspond exactement au trou qu'on
avait identifié côté protocole. Les deux moitiés du projet se rejoignent là.

---

# 8 · Le flux complet d'un échange

```
1. L'émetteur KYC délivre un credential à chaque membre        CredentialCreate
2. Chaque membre l'accepte  ← sans ça il ne vaut rien          CredentialAccept
3. Le gérant crée le domaine qui liste les credentials         PermissionedDomainSet
4. Le gérant crée le vault privé closed-ended                  VaultCreate
5. Les membres déposent (phase Subscription)                   VaultDeposit
   → ils reçoivent des parts ; un non-membre reçoit tecNO_AUTH
6. Le gérant crée le courtier et dépose son first-loss capital LoanBrokerSet + CoverDeposit
   ─── bascule en phase Investment : les retraits sont bloqués ───
7. Les prêts sont accordés, co-signés emprunteur + courtier    LoanSet
8. Les emprunteurs remboursent ; la valeur de la part monte    LoanPay

   ⚡ Une déposante a besoin de son argent. Elle ne peut pas sortir.

9. Elle publie une offre au carnet                             (hors chaîne)
10. Un acheteur la consulte — l'analyste note le vault         (hors chaîne)
11. Preflight : sept vérifications                             simulate
12. L'échange, en un Batch tfAllOrNothing :                    Batch
      · MPTokenAuthorize (acheteur)  ← doit venir en premier
      · Payment des parts   vendeur → acheteur
      · Payment du prix     acheteur → vendeur
13. Evidence : on retrouve les jambes dans le ledger           account_tx
14. Réconciliation : les soldes ont-ils bougé ?                account_objects
15. L'offre est marquée exécutée, le prix devient lisible on-chain
```

---

# 9 · Ce qu'on a mesuré

Environ 350 cas exécutés sur le Devnet public, sur 23 vaults et une centaine de
comptes. Les faits qui comptent.

## L'atomicité tient

Un `Batch` `tfAllOrNothing` dont la jambe du prix échoue **n'applique rien** — zéro
part déplacée. L'invariant est respecté, le produit repose sur du solide. Ce qui
manque, c'est le moyen de le **constater** : succès et non-effet rendent la même
réponse (voir §7).

Les `BatchSigners` couvrent aussi le contenu des jambes : un vendeur qui tenterait
de réécrire le prix après la signature de l'acheteur est rejeté. Et la séquence du
vendeur interdit la double-vente.

## Mais trois drapeaux sur quatre sont des pièges

| Drapeau | Résultat annoncé | Parts déplacées | Prix payé |
|---|---|---|---|
| `tfAllOrNothing` | `tesSUCCESS` | **0** | 0 |
| `tfOnlyOne` · `tfUntilFailure` · `tfIndependent` | `tesSUCCESS` | **300 000** | **0** |

Trois modes sur quatre **livrent sans encaisser**, et les quatre annoncent le
succès. On ne peut pas *oublier* le drapeau — `Flags: 0` est refusé — mais on peut
choisir le mauvais, et c'est **indétectable sans réconciliation des soldes**.

## L'économie du marché

```
frais d'un échange complet   200 drops   =  0,0152 % du prix
réserve chez l'acheteur      0,2 XRP     (l'objet MPToken)
décote de marché observée    12,1 %      sur 5 échanges réels
part illiquide du vault      13,3 %      des actifs sont prêtés
```

**Le rail coûte 800 fois moins cher que la décote.** La friction de ce marché
n'est pas technique — elle est entièrement dans le prix de l'illiquidité. C'est ce
qui justifie de construire le produit plutôt que d'optimiser la plomberie.

## Le gate est solide

Le contrôle de domaine s'applique au dépôt, au transfert direct, et au dénouement
d'un séquestre. Un non-membre reçoit `tecNO_AUTH` partout.

**Un piège quand même** : `MPTokenAuthorize` n'est **pas** filtré — n'importe qui
peut s'autoriser sur les parts. Détenir un objet `MPToken` ne prouve donc **rien**
sur l'éligibilité. Un carnet qui en déduirait le droit d'acheter se tromperait ;
le nôtre vérifie le credential.

## Ce qui nous a rassurés

- **Personne ne peut enfermer un déposant.** Les dates ne sont pas modifiables
  après création : le gérant **ne peut pas** repousser la Redemption. Un membre
  exclu du domaine peut toujours retirer.
- **Le pseudo-compte est étanche** — aucun paiement, séquestre ou chèque direct.
- **Aucune fuite d'arrondi**, sur 145 aller-retours en XRP et en IOU.

## Le bug qu'on a trouvé

`signLoanSetByCounterparty` du SDK signait avec l'ancien préfixe `STX\0` alors que
l'amendement `fixCleanup3_4_0`, actif sur ce Devnet, exige `CPT\0`. Résultat :
**aucun prêt n'était créable depuis le SDK publié** — la transaction centrale de
XLS-66.

Signalé aux organisateurs pendant l'événement. **`5.2.0-beta.1` embarque le
correctif**, revérifié sur la chaîne.

Deux points restent ouverts : la configuration d'intégration continue de `xrpl.js`
n'active toujours pas l'amendement, donc la régression peut revenir sans alerte ;
et `xrpl-py` porte encore le même défaut.

---

# 10 · Les questions ouvertes

**Pour les mentors Ripple**

1. **XLS-82 (MPTokensV2) est-il prévu, et quand ?** `OfferCreate` sur un MPT
   répond `temDISABLED` — le code existe. Le jour où il s'active, les parts se
   négocient nativement.
2. **Le blocage des retraits en phase Investment est-il définitif ?** C'est tout
   notre cas d'usage.
3. **L'échange de parts par `Batch` est-il un usage supporté, ou un effet de bord ?**
4. **Les MPT dans `Escrow` : intentionnel ?** Ça marche de bout en bout et ce n'est
   documenté nulle part.

**Pour nous**

- L'escrow comme rail d'engagement — le carnet d'offres deviendrait on-chain
- Les exécutions partielles : aujourd'hui chaque fraction paie son propre `Batch`
- Le calcul exact du plancher de retrait du cover, qui demande de lire la source
  de `rippled`
