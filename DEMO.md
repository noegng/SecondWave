# Script de démo — 4 minutes + 2 minutes de Q&A

Le règlement impose de couvrir **le cas d'usage**, **le flux on-chain**, et **les
trois frictions les plus importantes avec les améliorations proposées**. Ce
déroulé les couvre dans cet ordre.

---

## AVANT DE MONTER SUR SCÈNE

- [ ] **Régénérer le monde** — `npm run world`, puis vérifier `npm run cli vaults`.
      ⚠️ Le monde vieillit : les échéances tombent toutes les 120 s. Un monde
      d'il y a une heure a tous ses prêts en retard et le vault « sain » ne l'est plus.
      **Compter 12 minutes de génération.**
- [ ] `rm -f orderbook.json` — repartir d'un carnet vide
- [ ] Terminal en **grande police**, fond clair, fenêtre large (les tableaux ont besoin de place)
- [ ] `FEEDBACK.pdf` et le deck ouverts dans deux onglets, prêts
- [ ] Un onglet navigateur sur `devnet.xrpl.org`, prêt à coller un hash
- [ ] **Les notes de sécurité ont déjà été remontées à un mentor** *(obligation du règlement)*

---

## 0:00 — 0:40 · Le problème

**Slide 2.** Ne pas lire la slide, raconter.

> « Un vault closed-ended verrouille le capital. Pendant toute la phase Investment,
> `VaultWithdraw` répond `tecTOO_SOON` — le déposant ne peut pas sortir, point.
>
> Et pendant ce verrouillage, le risque se dégrade **sans que le prix bouge**.
> `AssetsTotal` ne change qu'au moment où le courtier déclare un impairment, et rien
> ne l'y oblige. Un prêt dont l'échéance et le délai de grâce sont dépassés depuis
> des heures laisse la valeur de la part parfaitement intacte. »

---

## 0:40 — 1:10 · Ce qu'on a construit

**Slide 3**, puis basculer sur le terminal.

> « Les parts d'un vault sont un MPT. Elles se transfèrent. La sortie existe déjà,
> elle n'est simplement pas outillée. On l'outille — et surtout on répond à la
> seule question qui compte pour l'acheteur : le vendeur brade, mais **pourquoi** ? »

---

## 1:10 — 2:10 · La démo — l'analyste sépare deux offres identiques

```bash
npm run cli vaults
```

Laisser respirer une seconde, puis pointer deux lignes :

> « Sept vaults. Celui-ci est noté sain. Celui-là est noté à fuir — et regardez la
> raison : **prêt défaillable non déclaré**. L'échéance et la grâce sont dépassées,
> le courtier n'a rien déclaré, donc la NAV est intacte. C'est invisible depuis le
> prix. »

```bash
npm run cli sell sain 3000000 2.6
npm run cli book sain.d1
```

> « Une offre, 13 % de décote. L'analyste ne dit pas seulement *risqué* — il dit
> **décote de détresse** plutôt que décote de liquidité, et il donne la raison.
> C'est toute la différence entre une opportunité et un piège, au même prix. »

---

## 2:10 — 2:50 · Le règlement, et sa preuve

```bash
npm run cli buy o001 sain.d1
```

Pendant que ça défile, commenter les trois moments :

> « Dix contrôles avant d'envoyer quoi que ce soit — dont le seuil de solvabilité
> de l'acheteur au drop près.
>
> Là : **`simulate` refuse de jouer un `Batch`**, il répond `notImpl`. On ne peut
> pas pré-vérifier la transaction dont tout dépend.
>
> Le `Batch` passe. Et ces deux jambes, on a dû aller les **reconstruire** dans le
> ledger, parce que le `Batch` ne les rapporte pas. Puis on compare les soldes —
> c'est la seule preuve que l'échange a eu lieu. »

---

## 2:50 — 3:40 · Les trois frictions

**Slides 6, 7, 8.** Une phrase-choc par slide, pas plus.

**Slide 6 — le `Batch` muet.**
> « Voilà ce que le serveur répond sur un `Batch` qui n'a **rien** fait : `accepted`,
> `applied: true`, `tesSUCCESS`, "The transaction was applied". Quatre champs qui
> disent que ça a marché. Un seul nœud de métadonnée : les frais.
>
> Huit `Batch` rejoués, cinq qui ont livré, trois qui n'ont rien fait — **une seule
> combinaison observée**. On ne peut pas distinguer les deux.
>
> On ne dit pas que `tesSUCCESS` est faux : "rien" est une issue légitime du tout-ou-rien.
> On dit qu'on ne peut pas savoir dans quel cas on est. Et XLS-56 spécifie un
> `BatchExecutions` exactement pour ça — il est absent.
>
> **Ce qu'on demande** : l'index de la jambe en échec et son code. Un entier et un code. »

**Slide 7 — les drapeaux.**
> « Le même échange sous les quatre drapeaux de `Batch`. Trois sur quatre **livrent
> les parts sans encaisser le prix**, en annonçant `tesSUCCESS`. On ne peut pas
> oublier le drapeau — mais on peut choisir le mauvais, et c'est indétectable.
>
> **Ce qu'on demande** : un helper de swap dans les SDK qui impose `tfAllOrNothing`. »

**Slide 8 — la lecture manquante.**
> « `vault_info` existe. Ni `loan_info`, ni `loan_broker_info`, ni la liste des
> détenteurs. Pour afficher ce que vous avez vu il y a une minute, il faut une
> traversée à trois niveaux et **rejouer tout l'historique** du pseudo-compte.
>
> C'est la partie du code qui nous a demandé le plus de travail, et elle ne
> reconstitue que ce que le serveur sait déjà. »

---

## 3:40 — 4:00 · La chute

**Slide 9**, puis **slide 10**.

> « 420 cas mesurés sur le Devnet. On a aussi trouvé un bloquant : `LoanSet` était
> insoumettable depuis le SDK, mauvais préfixe de signature — **c'est corrigé dans
> la beta.1**.
>
> Et une question qu'on vous laisse : le carnet d'ordres natif refuse les MPT,
> `temDISABLED`. C'est pour ça que notre carnet est hors chaîne. **Connaîtra-t-il
> les Permissioned Domains ?** Si oui, notre carnet devient inutile. Si non, c'est
> la seule voie pour un vault privé.
>
> Dans les deux cas, l'analyste reste : un carnet affiche un prix, il ne dit pas si
> c'est une aubaine ou un piège. »

---

## Q&A — les réponses préparées

**« Pourquoi le carnet n'est-il pas on-chain ? »**
> `OfferCreate` avec un MPT répond `temDISABLED` — le code existe, l'amendement
> dort. Et un escrow exige une `Destination`, donc pas d'offre au porteur non plus.
> Ce n'est pas un choix d'architecture, c'est une indisponibilité.

**« Le `tesSUCCESS` du `Batch`, ce n'est pas normal ? »**
> Si, complètement — `tfAllOrNothing` promet un invariant et le protocole le fait
> respecter. Notre point n'est pas que le code est faux : c'est que succès et
> non-effet sont **indiscernables** dans la réponse. XLS-56 prévoit un
> `BatchExecutions` pour ça, il est absent.

**« Un acheteur peut-il publier une demande ? »**
> Pas dans notre carnet, c'est un choix de périmètre. On a vérifié sur la chaîne
> que l'enveloppe d'un `Batch` peut être portée par l'acheteur — un carnet à deux
> côtés est constructible, on ne l'a pas branché.

**« Et si le vault est public ? »**
> Notre carnet devient largement redondant le jour où le DEX natif accepte les MPT.
> On l'assume : chez nous chaque fraction paie son propre `Batch`, le coût est
> linéaire ; sur un carnet natif il serait nul.

**« Quelle est votre pire hypothèse non vérifiée ? »**
> Que le DEX ignore les Permissioned Domains. C'est intestable tant que
> l'amendement dort, et c'est le seul endroit du dossier où on n'a pas de mesure.

**« Combien coûte un échange ? »**
> 200 drops, soit 0,0152 % du prix, plus 0,2 XRP de réserve immobilisée chez
> l'acheteur. La décote de marché observée est de 12 à 14 % : **le rail coûte 800
> fois moins cher que la décote**. La friction de ce marché n'est pas technique.

---

## Si la démo plante

Le monde vieillit et le Devnet peut avoir un hoquet. Deux replis :

1. **`npm run analyse -- predateur`** — l'analyste tourne **hors ligne** sur
   `snapshot.json`. Aucun réseau, ça ne peut pas échouer.
2. **Les liens du README** — chaque transaction XLS-65/66 y a sa preuve on-chain.
   Ouvrir `devnet.xrpl.org` et montrer le `Batch` à un seul nœud de métadonnée :
   c'est la friction n°1, en direct, sans dépendre de quoi que ce soit.

Ne jamais relancer `npm run world` sur scène — 12 minutes.
