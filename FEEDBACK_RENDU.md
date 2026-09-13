# Retour d’expérience — SecondWave

**À qui s’adresse ce texte :** le jury et l’équipe Ripple.  
**Ce que c’est :** ce que nous avons vraiment vécu en construisant un produit sur le protocole de prêt XRPL — pas un catalogue de codes d’erreur.

**Équipe :** Hugo (coffres, prêts, revente) · Noé (analyste de risque, portefeuille)  
**Piste :** Track 2 — Lending · coffres privés + pièces d’identité on-chain  
**Réseau :** Devnet public XRPL · septembre 2026

Les preuves techniques (scripts, hashes, versions) sont dans les [annexes](#où-sont-les-preuves). Ici, on raconte ce qui bloque un humain.

---

## En trente secondes

1. **La « garantie » du prêteur n’est presque jamais celle qu’on croit.** Un défaut peut faire porter **95 % de la perte aux déposants**, même quand le courtier affiche une grosse réserve.
2. **Pendant que l’argent est enfermé, le prix affiché peut rester beau.** Un prêt en retard ne change rien à l’écran tant que personne n’enregistre officiellement le problème. Nous avons retrouvé **22 coffres dans ce cas** sur les 40 plus gros du réseau, sans en avoir créé un seul.
3. **« Succès » ne veut pas dire que l’échange a eu lieu.** Réussite et non-effet sont indiscernables dans la réponse, et trois modes d’envoi sur quatre livrent les parts sans encaisser le prix.
4. **Une offre signée ne survivait pas à l’attente** — 72 secondes, et invalidée dès que l’un des deux fait autre chose. Nous avons trouvé comment la rendre durable ; ce n’est écrit nulle part.
5. **Le kit officiel a longtemps empêché de créer le moindre prêt.** Ripple l’a corrigé en cours d’événement — il reste des trous de documentation, de lecture, un portefeuille qui ne sait pas déposer du XRP dans un coffre, et **aucun portefeuille capable de signer un échange groupé**.

## Ce que nous avons construit

SecondWave est un **marché de sortie** pour des parts de coffre fermé, avec une **note de risque** à côté de chaque offre.

L’idée est simple. Une fois l’argent déposé dans un coffre « à durée fixe », on ne peut plus le retirer jusqu’à la date de sortie. Pendant ce temps, les prêts à l’intérieur peuvent mal tourner. Nous permettons de **revendre sa part** à quelqu’un d’autre, et nous disons si la décote est une **opportunité** (besoin de cash) ou un **piège** (le coffre est déjà malade).

Pour y arriver, il a fallu faire vivre tout le cycle sur le Devnet : identités, coffres, dépôts, courtiers, prêts, défauts, puis revente. C’est ce cycle — pas un tutoriel isolé — qui a fait apparaître les frictions ci-dessous.

---

## 1. La « garantie » n’est pas ce qu’on croit

C’est **le** point du projet. Hugo l’a mesuré côté protocole ; Noé l’a mis au cœur de l’analyste.

On nous parle d’un **capital de première perte** : une réserve que le courtier dépose, et qui devrait être mangée **avant** l’argent des épargnants. Le nom, et souvent l’écran, suggèrent : « s’il a 5 000 en caisse, les 5 000 protègent les déposants. »

Ce n’est pas ce que fait le réseau.

Au moment d’un défaut, le protocole ne prend **qu’une petite tranche calculée** — un pourcentage du pourcentage. Le reste de la caisse **reste chez le courtier**. Les déposants paient la différence. Ils ne peuvent pas sortir du coffre pendant ce temps.

**Même chiffres, deux lectures :**

| Ce qu’on voit | Ce qui se passe vraiment |
|---|---|
| Réserve affichée : 5 000 | Seuls **500** peuvent partir au défaut |
| « On est largement couverts » | **95 %** de la perte va aux déposants |
| Le surplus a l’air rassurant | Les **4 500** restants ne bougent pas |

L’exemple officiel de la documentation **calcule déjà** ce genre de résultat (environ 11 de protection sur 1 090 de défaut). Il ne le dit jamais en une phrase : *presque tout ce défaut n’est pas de la première perte.*

Deux corollaires, tout aussi simples :

- **Dès qu’il n’y a plus de prêt en cours**, le courtier peut **rapatrier 100 %** de sa réserve. Ce n’est pas un matelas permanent.
- **Un prêt en retard ne fait pas baisser le prix du coffre.** Le chiffre affiché ne bouge que quand quelqu’un déclare officiellement une perte. Jusque-là, le déposant est coincé derrière un prix trop beau.

**Ce que nous demandons :** une phrase unique, bien visible, dans la page « First-Loss Capital » : *la protection réelle au défaut n’est pas l’argent en caisse, c’est le petit plafond prévu par les taux.* Et, plus tard, un champ déjà calculé (« protection maximale ») pour que les portefeuilles n’aient pas à le réinventer.

---

## 2. Une fois dedans, on ne sort pas — parfois même plus

Un coffre à durée fixe **interdit le retrait** pendant toute la période d’investissement. C’est le produit. Nous l’avons accepté.

Le piège, c’est la **combinaison** avec l’identité on-chain. Nos coffres sont privés : seuls les titulaires d’une pièce d’identité acceptée peuvent y entrer, et aussi **recevoir** une part.

Si cette pièce expire ou est retirée pendant que l’argent est enfermé :

- on ne peut **pas retirer** (trop tôt) ;
- on ne peut **pas vendre** à un acheteur pourtant valide (le réseau refuse le transfert).

La personne qui a le plus besoin d’une sortie de secours est celle à qui on l’interdit. Le retrait reste possible **à la date de sortie**, même sans pièce — mais jusque-là, la position est gelée.

**Ce que nous demandons :** trancher clairement si vendre *vers l’extérieur* (sortir du coffre) doit rester possible quand on n’est plus membre. Aujourd’hui, le filet de sécurité arrive trop tard.

---

## 3. Le portefeuille officiel ne peut pas déposer du XRP

Noé a voulu souscrire depuis **l’extension wallet Ripple**, comme un utilisateur normal, pas comme un script.

Le coffre attend une somme en XRP sous une forme simple. L’extension envoie toujours la somme **comme s’il s’agissait d’un jeton** (un objet avec une devise). Le réseau refuse. Le message dit seulement que le champ est invalide — **sans dire que le type est faux**. L’utilisateur **ne peut pas corriger** le JSON.

Résultat : **impasse**. On ne peut pas rejoindre un coffre en XRP depuis l’outil officiel.

Nous avons corrigé le bug dans une copie de l’extension et ouvert une pull request. Le produit SecondWave n’y peut rien : c’est le premier contact réel d’un déposant avec XLS-65.

**Ce que nous demandons :** si le coffre est en XRP, envoyer le montant comme une simple chaîne ; garder l’objet « jeton » uniquement pour les IOU. Et un message qui dit *« ce coffre attend du XRP, pas un jeton »*.

---

## 4. Pendant plusieurs jours, aucun prêt n’était possible

Pour prêter, les deux parties doivent **co-signer** la même opération. Le kit JavaScript officiel signait avec **l’ancienne recette**. Le réseau, lui, exigeait **la nouvelle**. Refus immédiat. L’exemple officiel du site cassait de la même façon.

Conséquence concrète : **la transaction centrale du protocole de prêt était inutilisable** avec l’outil qu’on nous demandait d’utiliser.

Ripple a publié une version corrigée en cours d’événement. Nous l’avons revérifiée sur la chaîne : ça passe. Merci — c’est le genre de correction qui débloque tout un hackathon.

Il reste deux angles morts :

- les **tests automatiques** du kit n’activent pas encore le nouveau régime : le bug peut **revenir sans alerte** ;
- le kit **Python** a encore l’ancien comportement.

C’est aussi une bonne histoire de pitch : bloquant trouvé, compris, corrigé. Mais un développeur arrivé le premier jour a perdu une journée.

---

## 5. « Succès » ne veut pas dire que l’échange a eu lieu

C’est la friction qui nous a coûté le plus de code, et celle qu’on n’avait pas vue venir.

Pour revendre une part, nous envoyons **plusieurs opérations d’un coup**, en tout ou rien : l’acheteur s’autorise à recevoir les parts, les parts bougent, l’argent bouge. Trois jambes, une seule transaction.

Le réseau répond **succès**. Le problème est que ce mot ne distingue pas deux situations opposées.

**Ce que le serveur renvoie quand l’échange a eu lieu, et quand il n’a rien fait :**

| Champ | Échange réussi | Rien ne s’est appliqué |
|---|---|---|
| Réponse | `accepted` | `accepted` |
| Appliquée | `true` | `true` |
| Code | `tesSUCCESS` | `tesSUCCESS` |
| Texte | « The transaction was applied » | « The transaction was applied » |
| Métadonnée | **un seul nœud : les frais** | **un seul nœud : les frais** |

Huit envois rejoués : cinq ont livré, trois n’ont rien fait. **Une seule combinaison observée.** Rien dans la réponse ne permet de les séparer.

Nous en avons trouvé une illustration de plus en testant tout autre chose : un échange de 900 XRP tenté par un acheteur qui ne les a pas. Aucun centime ne bouge — le tout-ou-rien tient parfaitement — et le serveur répond quand même **succès**. Un marché naïf enregistrerait la vente.

Nous ne disons pas que ce code est faux. « Rien » est une issue légitime du tout-ou-rien. Nous disons qu’on ne peut pas savoir dans quel cas on se trouve. La spécification prévoit pourtant un champ de compte rendu par jambe, **exactement pour ça**. Il est absent de ce que renvoie le serveur.

**Trois conséquences que nous avons dû payer en code :**

- **Reconstruire les jambes à la main.** Elles existent dans le ledger, comme transactions distinctes du même bloc, avec leurs propres empreintes. Il faut aller les rechercher compte par compte sur l’intervalle du bloc. C’est la partie la plus fragile de notre règlement, et elle ne reconstitue que ce que le serveur sait déjà.
- **Comparer les soldes avant et après.** C’est notre seule preuve qu’un échange a eu lieu. Tout produit sérieux devra faire la même chose.
- **Ne jamais pré-vérifier.** L’outil de simulation refuse les envois groupés — il répond « non implémenté ». La transaction dont tout dépend est la seule qu’on ne peut pas tester à blanc.

**Et le choix du mode est un piège silencieux.** Nous avons rejoué le même échange sous les quatre modes d’envoi. **Trois sur quatre livrent les parts sans encaisser le prix**, en annonçant un succès. On ne peut pas oublier de choisir un mode — mais on peut choisir le mauvais, et rien ne le signale. Pour un échange d’argent contre des parts, un seul est correct.

Deux détails de la même famille, découverts en tapant à côté :

- un envoi groupé de **moins de deux jambes** est refusé avec « tableau vide », alors que le tableau ne l’est pas ;
- la jambe d’autorisation de l’acheteur **doit être la première**. Placée ailleurs, la livraison des parts échoue et tout est annulé. Rien ne le dit.

**Ce que nous demandons :**

1. Que la réponse porte **l’index de la jambe en échec et son code**. Un entier et un code — le champ est déjà spécifié, il suffit de le remplir.
2. Un avertissement en tête de la page : *pour échanger de la valeur, n’utiliser que le mode tout-ou-rien*, et un raccourci dans les kits qui l’impose.
3. Que l’outil de simulation accepte les envois groupés. C’est la transaction qu’on a le plus besoin de tester.

---

## 6. Les messages d’erreur ne disent pas quoi corriger

C’est le fil rouge de tout le week-end. Quelques scènes vécues :

**« Transaction mal formée. »**  
Un coffre refusé parce que les dates sont trop rapprochées, trop éloignées, qu’un champ est interdit sur le XRP, ou qu’il manque un drapeau. Le serveur dit la même phrase à chaque fois. Les messages utiles n’existent que **dans le kit JavaScript**. Quelqu’un qui signe autrement n’a rien.

**« Expiré. »**  
Ce mot unique veut dire quatre choses différentes : un remboursement un peu trop tard, un dépôt hors de la fenêtre d’entrée, un prêt lancé trop tard, une pièce d’identité périmée. Impossible de savoir lequel sans tout relire à la main. Et pour le remboursement en retard, le réseau attend un **drapeau spécial** que le message ne mentionne jamais.

**« Pas la permission. »**  
Souvent, ce n’est pas une question de droits. C’est « tes dates de prêt sont trop près de la sortie du coffre » ou « ce type de coffre n’accepte pas de courtier ». On cherche un problème d’identité ; c’est un problème de calendrier.

**Une règle invisible, une session perdue.**  
La période de grâce d’un prêt doit durer **au moins une minute**, et **pas plus longtemps** que l’intervalle entre deux échéances. Nulle part dans la doc. Le refus est encore « mal formé ». Nous avons testé trois fausses pistes avant de tout balayer.

Même famille : trois champs s’appellent tous « taux » et ne veulent pas dire la même chose (intérêt annuel, plancher de réserve, part liquidée au défaut). Sans tableau, on se trompe d’un facteur 10 ou 20 à l’affichage.

**Ce que nous demandons :** nommer **le champ** et **la règle** dans le message. `expiré` et `pas la permission` devraient devenir des phrases du type : *« remboursement en retard : ajouter le drapeau correspondant »* ou *« dernière échéance trop proche de la date de sortie »*.

---

## 7. Impossible de simplement demander « montre-moi ce prêt »

Il existe une lecture pour **le coffre**. Il n’en existe **aucune** pour un prêt, pour un courtier, ni pour la liste des gens qui tiennent des parts.

Pour analyser un coffre, nous devons :

1. lire le coffre ;
2. lister les objets du compte technique du coffre (les courtiers) ;
3. pour chaque courtier, relister ses prêts ;
4. pour les porteurs de parts, **rejouer tout l’historique** du compte, parce que personne ne fournit la liste.

Un prêt remboursé et effacé **disparaît**. Il n’y a pas d’historique de crédit on-chain. Toute note de risque sérieuse exige un indexeur à côté.

On ne peut pas non plus **simuler** un prêt avant de l’envoyer (il manque la deuxième signature), ni simuler un échange groupé. Les opérations les plus difficiles à construire sont celles qu’on ne peut pas tester à blanc.

**Ce que nous demandons :** trois lectures métier — le prêt, le courtier, les porteurs de parts — et le droit de simuler un prêt et un échange groupé.

---

## 8. Ce qui tourne sur le réseau n’est pas dans la doc

Le Devnet fait déjà tourner une **version plus récente** du protocole (coffres à trois phases : entrée, investissement, sortie). Les champs existent. Le kit les connaît. **Aucune page publiée ne les décrit.**

Nous avons tout appris par essai-erreur :

- un courtier **n’existe que** sur un coffre à durée fixe ;
- un champ « date de début » est **interdit** à la création du prêt (il est calculé tout seul) ;
- un champ « données libres » est **accepté puis jeté** — succès apparent, information perdue ;
- un coffre en XRP **refuse** un champ d’échelle qui n’existe que pour les jetons.

Même surprise côté revente : **mettre des parts sous séquestre fonctionne**, jusqu’à un échange atomique sans opération groupée. Rien ne le dit. Nous l’avons découvert en tapant à côté.

À l’inverse, le carnet d’ordres natif **refuse encore** de coter ces parts (« cette logique est éteinte »). Le code est là, l’interrupteur est off. On ne sait pas si c’est pour demain ou pour dans deux ans — et ça décide si notre marché pair-à-pair a encore un sens.

---

## 9. Une offre signée ne survit pas à l’attente

C’est le problème qui décide si on construit un **marché** ou une **poignée de main**. Nous ne l’avons compris qu’en essayant de faire attendre une offre.

Quand deux personnes s’échangent des parts contre de l’argent, chacune signe. Mais ce que chacune signe contient **le compteur de transactions de l’autre**. Résultat : dès que l’un des deux fait n’importe quelle autre opération, l’offre déjà signée devient invalide. Et l’enveloppe porte une date limite courte — nous avons mesuré **72 secondes** sur le Devnet.

Concrètement : le vendeur ne peut pas signer maintenant et laisser l’acheteur se manifester plus tard. Les deux doivent être devant leur écran, en même temps, pendant une minute. Ce n’est pas un carnet d’ordres, c’est un rendez-vous.

**Ce que nous avons trouvé, et qui change tout.** Le protocole a de quoi réserver un numéro de transaction à l’avance. En l’utilisant à la place du compteur ordinaire, tout se débloque. Nous l’avons mesuré sur sept cas :

| Ce qu’on a testé | Résultat |
|---|---|
| Numéro réservé sur l’enveloppe | accepté |
| Numéro réservé sur chaque jambe interne | accepté |
| **Offre signée, puis les deux comptes font autre chose, puis on envoie** | **elle passe** |
| Date limite portée à 10 min, 1 h, 24 h, 7 jours, 8 ans | toutes acceptées |
| Aucune date limite du tout | acceptée |

Une offre signée devient donc **durable**. Et l’annulation existe aussi : consommer le numéro réservé rend l’offre inexécutable pour toujours, **même si l’autre partie l’a déjà signée**. Coût mesuré : **1 drop**.

Deux remarques qui comptent pour la suite :

- **Rien de tout cela n’est écrit.** Le kit JavaScript lit déjà le numéro réservé quand il assemble les signatures — la mécanique est prévue. Aucune page ne dit qu’on peut porter un échange groupé de cette façon, ni ce que ça permet.
- **Une offre sans date limite n’est pas souhaitable non plus.** Tant que l’acheteur a signé et que le vendeur ne l’a pas fait, le vendeur détient une **option gratuite** : il exécute le jour qui l’arrange, éventuellement un an plus tard, sur un coffre qui aura changé de nature entre-temps. L’acheteur paierait le prix d’hier pour l’actif d’aujourd’hui. Nous avons donc remis une échéance — mais sur **l’engagement** de l’acheteur, pas sur l’annonce du vendeur, qui elle n’engage personne.

**Ce que nous demandons :** documenter qu’un échange groupé peut être porté par un numéro réservé, et ce que ça implique — c’est la différence entre un marché et un rendez-vous. Et, dans la même page, dire que l’absence de date limite transfère une option gratuite à celui qui signe en dernier.

---

## 10. On ne peut pas demander la liste des coffres

Pour noter le risque d’un coffre, encore faut-il le trouver. Il n’existe **aucune lecture** qui réponde « voici les coffres ». La seule voie est de **balayer le ledger** en filtrant par type d’objet.

Mesuré sur le Devnet : **489 coffres en 11 secondes**, sur 60 pages — et le balayage était encore **tronqué**. Ensuite, savoir si l’un d’eux mérite un regard demande de le relire entièrement, un par un : pour les 40 plus gros, environ 27 secondes de plus.

Ce n’est pas un détail de performance. C’est ce qui décide si un analyste indépendant peut exister. Et le jeu en vaut la chandelle : sur ces 40 coffres, **22 avaient un prêt en défaut non déclaré**. Le signal que nous cherchions existe bel et bien dans la nature, sur des adresses qui ne sont pas les nôtres — mais personne ne peut le voir sans balayer toute la chaîne.

C’est la même famille que le point 7 : il manque le prêt, le courtier, les porteurs de parts… et la liste des coffres elle-même.

**Ce que nous demandons :** une lecture qui liste les coffres, avec au minimum un filtre par propriétaire et par type. À défaut, dire clairement dans la doc que tout produit de ce domaine a besoin d’un indexeur, et à quoi il doit ressembler.

---

## 11. Aucun portefeuille ne sait signer un échange groupé

C’est notre dernier point, et c’est peut-être le plus gênant pour l’écosystème.

L’échange groupé fonctionne sur la chaîne. Nous l’avons utilisé des dizaines de fois. Mais il est **hors de portée d’un portefeuille**. Nous avons lu le code du portefeuille de développement officiel : **le mot n’y apparaît nulle part**. Ni l’échange groupé, ni le séquestre. Il sait créer et envoyer des jetons, accepter une pièce d’identité, et il a bien un écran de dépôt dans un coffre — celui du point 3, qui ne passe pas en XRP. Mais il ne sait signer **ni l’une ni l’autre** des deux opérations qui permettent un échange atomique.

Le protocole de connexion entre un site et un portefeuille déclare bien une méthode « signer pour le compte d’un tiers », qui est exactement ce qu’il faudrait. Aucun portefeuille ne l’implémente pour les échanges groupés.

La conséquence est brutale pour un produit : **tout marché pair-à-pair doit signer côté serveur**, avec les clés de ses utilisateurs. C’est-à-dire devenir dépositaire — précisément ce que ce protocole cherche à éviter. Notre interface le fait, en local, et nous l’assumons comme une limite de démonstration. Nous ne la mettrions pas en ligne.

**Ce que nous demandons :** que l’échange groupé entre dans le portefeuille officiel et dans le standard de connexion, avec un écran de revue lisible (« vous livrez X, vous recevez Y, tout ou rien »). Tant que ce n’est pas le cas, la partie la plus intéressante du protocole reste réservée à ceux qui écrivent des scripts.

---

## 12. Une proposition : un séquestre sans destinataire nommé

Les trois points précédents se rejoignent sur un même mur, et nous voudrions proposer une sortie.

Aujourd’hui, **le vendeur doit connaître son acheteur avant de s’engager**. C’est vrai des deux côtés :

- l’échange groupé : l’adresse de l’acheteur est **à l’intérieur** de ce que le vendeur signe ;
- le séquestre : il exige un **destinataire** nommé à la création.

Il n’existe donc aucune façon de dire « je vends 1 000 parts à ce prix, au premier qui les prend ». Le carnet d’ordres natif refuse encore de coter ces parts. Un vendeur qui veut sortir doit **trouver son acheteur ailleurs**, puis revenir signer. C’est pour ça que notre carnet est hors chaîne — ce n’est pas un choix d’architecture, c’est une indisponibilité.

**Pourquoi nous pensons qu’un séquestre au porteur serait raisonnable *ici*.**

L’objection habituelle est évidente : un séquestre que n’importe qui peut réclamer, c’est une porte ouverte. Mais dans un coffre privé, **« n’importe qui » n’existe pas**. L’accès est déjà borné par un domaine permissionné (XLS-0080) et les pièces d’identité qu’il accepte (XLS-0070). Seuls les membres du domaine peuvent détenir ces parts — le réseau le vérifie au dépôt, au transfert, et **encore au dénouement du séquestre**, nous l’avons testé.

Autrement dit, le contrôle que le destinataire nommé apporte est **déjà apporté par le domaine**. Le nommer une seconde fois n’ajoute pas de sécurité : ça retire seulement la possibilité d’un marché.

**Ce que nous demandons :** pouvoir créer un séquestre de parts en indiquant **un domaine** à la place d’un destinataire. Le premier membre en règle qui dénoue prend la position, contre le prix prévu. Le vendeur s’engage une fois, publiquement, sans savoir qui répondra — et sans que la confiance diminue, puisque tous les répondants possibles sont déjà authentifiés.

Cela donnerait au protocole un vrai carnet d’ordres pour les coffres privés, sans attendre que le carnet natif accepte ces parts — et sans que quiconque ait à faire confiance à un intermédiaire hors chaîne comme le nôtre.

---

## Ce qui nous a rassurés

Tout n’est pas cassé. Ces points ont tenu, et ils méritent d’être gardés.

- **Le propriétaire du coffre ne peut pas reculer la date de sortie.** Une fois écrite, elle est écrite. Pas d’enfermement « encore six mois » décidé après coup.
- **Perdre sa pièce d’identité n’empêche pas de retirer** à la date prévue. Seul un gel de jeton (réversible) bloque une sortie.
- **L’argent du coffre ne fuit pas** vers des paiements ordinaires. On ne peut pas non plus empiler un coffre dans un autre coffre.
- **Aucun centime perdu en arrondi** sur des centaines d’aller-retours, en XRP comme en jetons.
- **Le mode tout-ou-rien tient vraiment** : nous n’avons pas réussi à le casser. Si l’acheteur signe puis que le vendeur change le prix, le réseau refuse.
- **Le contrôle d’identité est étanche** et revérifié partout : dépôt, transfert, séquestre, y compris à la fin du séquestre.
- **La correction du kit en cours d’événement** a débloqué le cœur du protocole. C’est le bon réflexe.

---

## Ce que nous demandons, en sept points

1. **Dire la vérité sur la garantie**, en une phrase, là où les gens lisent. La caisse n’est pas la protection.
2. **Des messages d’erreur qui nomment le champ et la règle.** Moins de « mal formé », « expiré », « pas la permission » fourre-tout.
3. **Pouvoir lire un prêt, un courtier, qui tient les parts — et la liste des coffres** — sans reconstruire le monde à la main.
4. **Que « succès » veuille dire « l’échange a eu lieu » :** l’index de la jambe en échec et son code, et un avertissement sur le choix du mode d’envoi.
5. **Documenter ce qui tourne déjà** (coffres à trois phases, règles de dates, vrais sens des taux, séquestre de parts) — et dire si le carnet natif cotera un jour ces parts.
6. **Documenter qu’un échange groupé peut être porté par un numéro réservé.** C’est ce qui sépare un marché d’un rendez-vous de 72 secondes, et ce n’est écrit nulle part.
7. **Mettre l’échange groupé dans les portefeuilles.** Tant qu’aucun ne sait le signer, tout marché pair-à-pair est forcé d’être dépositaire.

Et une proposition, plutôt qu’une demande : **un séquestre adressé à un domaine** plutôt qu’à une personne (point 12). Le portefeuille officiel devrait aussi savoir déposer du XRP dans un coffre (point 3).

## Questions pour Ripple

1. **Le carnet d’ordres natif** pourra-t-il un jour coter des parts de coffre — et respectera-t-il les coffres privés ? Si oui, notre marché pair-à-pair devient un pont temporaire. Si non, il reste le produit.
2. **L’interdiction de sortir pendant l’investissement** est-elle définitive, y compris pour quelqu’un qui n’est plus membre ?
3. **Revendre via une opération groupée**, c’est un usage supporté ou un effet de bord que vous pouvez casser plus tard ?
4. **Un courtier « trop prudent »** (plus d’argent en caisse que le plafond) pourra-t-il un jour offrir vraiment plus de protection, sans bricoler les taux ?
5. **Porter une opération groupée par un numéro réservé** — est-ce prévu, toléré, ou involontaire ? Le kit le fait déjà à moitié ; nous avons construit dessus et nous aimerions savoir si nous avons eu raison.
6. **Un séquestre adressé à un domaine** plutôt qu’à une personne : est-ce que ça se heurte à quelque chose que nous ne voyons pas ? C’est notre seule vraie piste pour un carnet d’ordres on-chain sur des parts privées.

## Où sont les preuves

Ce texte fusionne le travail des deux côtés de l’équipe. Les versions longues restent la référence pour un mentor ou une reproduction.

| Fichier | Qui | Quoi |
|---|---|---|
| [FEEDBACK.md](./FEEDBACK.md) | surtout Hugo | Rapport technique (kit, opérations groupées, messages, lectures manquantes) |
| [FEEDBACK_XLS65_XLS66.md](./FEEDBACK_XLS65_XLS66.md) | surtout Noé | Fiche first-loss + portefeuille, avec formules et preuves |
| [probes/FRICTIONS.md](./probes/FRICTIONS.md) | Hugo | Repros coffres / prêts |
| [probes-marche/FRICTIONS.md](./probes-marche/FRICTIONS.md) | Hugo | Repros revente / séquestre |
| [FRICTIONS-annexe.md](./FRICTIONS-annexe.md) | Hugo | Version longue marché |
| [probes-marche/13-tickets-et-batch.mjs](./probes-marche/13-tickets-et-batch.mjs) | Hugo | Offre durable : 7 cas, jambes vérifiées dans le ledger (point 9) |
| [probes-marche/14-annulation-par-ticket.mjs](./probes-marche/14-annulation-par-ticket.mjs) | Hugo | Annulation opposable d’une offre déjà signée (point 9) |
| [probes-marche/15-fenetre-maximale.mjs](./probes-marche/15-fenetre-maximale.mjs) | Hugo | Jusqu’où repousser l’échéance : 10 min → 8 ans (point 9) |
| [probes-marche/16-deux-achats-en-parallele.mjs](./probes-marche/16-deux-achats-en-parallele.mjs) | Hugo | Deux achats simultanés, et un envoi sans provision qui répond « succès » (point 5) |
| [probes-marche/12-vaults-publics.mjs](./probes-marche/12-vaults-publics.mjs) | Hugo | Balayage du réseau : 489 coffres, 22 en défaut non déclaré (point 10) |

Environ 450 cas rejoués sur le Devnet, une trentaine de coffres créés et 489 balayés. Chaque point technique a un script dans le dépôt.

*Les pistes de sécurité se transmettent de vive voix, comme le règlement le demande. Elles ne sont pas dans ce document.*
