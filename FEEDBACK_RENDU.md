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
2. **Pendant que l’argent est enfermé, le prix affiché peut rester beau.** Un prêt en retard ne change rien à l’écran tant que personne n’enregistre officiellement le problème.
3. **Le kit officiel a longtemps empêché de créer le moindre prêt.** Ripple l’a corrigé en cours d’événement — il reste des trous de documentation, de lecture, et un portefeuille qui ne sait pas déposer du XRP dans un coffre.

---

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

Pour revendre une part, nous envoyons **plusieurs opérations d’un coup** (tout ou rien) : l’acheteur s’autorise à recevoir les parts, les parts bougent, l’argent bouge.

Le réseau répond souvent **succès**. Sauf que :

- le même « succès » arrive quand **rien n’a bougé** (sauf les frais) ;
- le détail promis par la spécification (**qui** a réussi, **qui** a échoué) **n’est pas dans la réponse** ;
- avec trois modes d’envoi sur quatre, on peut **livrer les parts sans encaisser le prix** — et la réponse a encore l’air d’un succès.

Nous avons appris à **toujours comparer les soldes avant et après**. Sans ça, un marché croit avoir vendu alors qu’il n’a rien fait — ou pire, qu’il a donné les parts.

**Ce que nous demandons :** que la réponse distingue « tout s’est appliqué » de « rien ne s’est appliqué ». Et, dans la doc, un gros avertissement : *pour un échange d’argent contre des parts, n’utiliser que le mode tout-ou-rien.*

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

## Ce que nous demandons, en cinq points

1. **Dire la vérité sur la garantie**, en une phrase, là où les gens lisent. La caisse n’est pas la protection.
2. **Des messages d’erreur qui nomment le champ et la règle.** Moins de « mal formé », « expiré », « pas la permission » fourre-tout.
3. **Pouvoir lire un prêt, un courtier, et qui tient les parts** — sans reconstruire le monde à la main.
4. **Que « succès » veuille dire « l’échange a eu lieu »**, et que le portefeuille officiel sache déposer du XRP dans un coffre.
5. **Documenter ce qui tourne déjà** (coffres à trois phases, règles de dates, vrais sens des taux, séquestre de parts) — et dire si le carnet natif cotera un jour ces parts.

---

## Questions pour Ripple

1. **Le carnet d’ordres natif** pourra-t-il un jour coter des parts de coffre — et respectera-t-il les coffres privés ? Si oui, notre marché pair-à-pair devient un pont temporaire. Si non, il reste le produit.
2. **L’interdiction de sortir pendant l’investissement** est-elle définitive, y compris pour quelqu’un qui n’est plus membre ?
3. **Revendre via une opération groupée**, c’est un usage supporté ou un effet de bord que vous pouvez casser plus tard ?
4. **Un courtier « trop prudent »** (plus d’argent en caisse que le plafond) pourra-t-il un jour offrir vraiment plus de protection, sans bricoler les taux ?

---

## Où sont les preuves

Ce texte fusionne le travail des deux côtés de l’équipe. Les versions longues restent la référence pour un mentor ou une reproduction.

| Fichier | Qui | Quoi |
|---|---|---|
| [FEEDBACK.md](./FEEDBACK.md) | surtout Hugo | Rapport technique (kit, opérations groupées, messages, lectures manquantes) |
| [FEEDBACK_XLS65_XLS66.md](./FEEDBACK_XLS65_XLS66.md) | surtout Noé | Fiche first-loss + portefeuille, avec formules et preuves |
| [probes/FRICTIONS.md](./probes/FRICTIONS.md) | Hugo | Repros coffres / prêts |
| [probes-marche/FRICTIONS.md](./probes-marche/FRICTIONS.md) | Hugo | Repros revente / séquestre |
| [FRICTIONS-annexe.md](./FRICTIONS-annexe.md) | Hugo | Version longue marché |

Environ 420 cas rejoués sur le Devnet, une trentaine de coffres. Chaque point technique a un script dans le dépôt.

*Les pistes de sécurité se transmettent de vive voix, comme le règlement le demande. Elles ne sont pas dans ce document.*
