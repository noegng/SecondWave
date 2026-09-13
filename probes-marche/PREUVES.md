# Preuves on-chain — points 5 et 9 du rendu

Généré par `probes-marche/17-preuves.mjs` sur le **Devnet public XRPL**.
Chaque lien s'ouvre dans l'explorateur : rien ici ne demande de nous croire.

Comptes de la campagne :
- vendeur `rHtJCFBthXzBHgGfDkPeAgRJdptf7Z3a57`
- acheteur `rDaqeMX6Vb7HCszYUV2NGbzyLL6tCgowJZ`

| # | Ce qui est affirmé | Transaction | Détail |
|---|---|---|---|
| A | un échange groupé qui livre réellement | [`1F5EC759C41A…`](https://devnet.xrpl.org/transactions/1F5EC759C41AE11D981E1A93F1D72835D863B8F02ECB5C9D91C08AD4368BA04F) | tesSUCCESS · 3 nœuds · ledger 5276090 |
| A1 | jambe reconstruite — Payment | [`070FD589D834…`](https://devnet.xrpl.org/transactions/070FD589D83474A33031F72C68609F647A2F47A9D3BFB7E091F1FD000FF2DC66) | tesSUCCESS |
| A2 | jambe reconstruite — Payment | [`DF08C89BBB71…`](https://devnet.xrpl.org/transactions/DF08C89BBB7184C7DE534126D3D59AFA8196D17BCC8A8EB23A8E11A2D35E3EFE) | tesSUCCESS |
| B1 | le vendeur transige entre la signature et l'envoi | [`A9DBF949E261…`](https://devnet.xrpl.org/transactions/A9DBF949E26105F03CA5B32D5994303D6086D236068557AA60C221E67EFFF162) | tesSUCCESS |
| B2 | l'acheteur transige entre la signature et l'envoi | [`D3526FA8FF63…`](https://devnet.xrpl.org/transactions/D3526FA8FF634AA89C5A9817B478A1206154EFEB4211FB422A0ACAB2EBD830B2) | tesSUCCESS |
| C | la même offre, envoyée APRÈS ce bruit — elle passe | [`8C7EA4C9D264…`](https://devnet.xrpl.org/transactions/8C7EA4C9D264C4AE31E1D5260855B09037C6FE9AD2F062DF215C6767F3BCCE9D) | tesSUCCESS · c'est ce que les Tickets rendent possible |
| D | le vendeur consomme le ticket qui porte l'offre | [`55367484A867…`](https://devnet.xrpl.org/transactions/55367484A867D99F591F33FCC8F339A1FAE2B108C1D574632A755ACD16E0F87E) | tesSUCCESS · frais 1 drops |
| D2 | rejouer l'offre annulée | — | tefNO_TICKET — une transaction refusée n'entre pas dans le ledger, elle n'a pas de lien |
| E | échange de 900 XRP que l'acheteur ne possède pas | [`D25D7C76BEB2…`](https://devnet.xrpl.org/transactions/D25D7C76BEB2AF31A5EEF5556CC4FAE29E1DC88DAAD9ADD4FBCA3E899DF14356) | réponse tesSUCCESS · 3 nœuds · solde acheteur 94999996 → 94999996 (inchangé) |

## Comment lire ces preuves

**A et ses jambes — le `BatchExecutions` manquant (point 5).** L'échange groupé A
a livré. Ouvrez-le : sa métadonnée ne contient **que la ponction de frais**.
Les jambes A1 à A3 sont des transactions distinctes du même bloc, avec leurs
propres empreintes — nous avons dû aller les rechercher compte par compte. Le
serveur les connaît et ne les rapporte pas.

**B1, B2 et C — l'offre durable (point 9).** L'offre C est signée par les deux
parties AVANT B1 et B2. Les deux comptes transigent ensuite, ce qui déplace
leurs compteurs. C est envoyée après, et passe. Sur le rail ordinaire, elle
serait morte : c'est le couplage aux compteurs qui rendait une offre signée
périssable, et c'est ce que les numéros réservés lèvent.

**D — l'annulation opposable (point 9).** Le vendeur consomme le numéro qui
porte l'offre, pour quelques drops. Le rejeu de l'offre signée est alors
refusé. Notez qu'il n'y a **pas de lien** pour ce refus : une transaction
rejetée n'entre jamais dans le ledger. C'est justement pourquoi l'exhibit
suivant est précieux.

**E, comparé à A — le cœur du point 5.** E est un échange de 900 XRP tenté par
un compte qui ne les a pas. Le solde de l'acheteur est **inchangé** : le
tout-ou-rien tient parfaitement, rien n'a bougé.

Ouvrez maintenant A et E côte à côte. A a livré 3 XRP ; E n'a rien fait. Voici
ce que le ledger enregistre de chacun :

| | A (a livré) | E (n'a rien fait) |
|---|---|---|
| Code | `tesSUCCESS` | `tesSUCCESS` |
| Nœuds de métadonnée | Deleted Ticket, Modified AccountRoot, Modified DirectoryNode | Deleted Ticket, Modified AccountRoot, Modified DirectoryNode |
| Variation de solde | -150 drops (frais) | -150 drops (frais) |

**Identiques.** Même code, mêmes nœuds, mêmes frais
(l'ordre des nœuds n'est pas significatif, on compare des ensembles). Aucun des deux ne
laisse dans sa propre métadonnée la moindre trace de ce qui a bougé — ou pas.
La seule façon de les distinguer est d'aller chercher ailleurs dans le bloc si
des jambes existent, puis de comparer les soldes avant et après.

C'est aussi la seule forme de preuve possible pour cette friction : un échec
franc laisserait une trace lisible, ce succès-là n'en laisse aucune.
