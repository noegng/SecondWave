# QA — passe produit complète (branche `hugo1`, 12/09 après-midi)

But : dérouler la boucle produit de bout en bout (monde → snapshot → analyste offline
→ marché on-chain → démo CLI) et consigner chaque accroc. Trouvailles classées :
🔴 à corriger · 🟠 à discuter en équipe · ℹ️ observation.

## 🔴 1. `world.json`/`snapshot.json` committés vs `state.json` gitignoré : désynchronisation garantie en équipe
**Constat** : après le pull de `main`, 0/7 seeds de `state.json` local ne correspondent
aux owners de `world.json` (vérifié en dérivant les adresses). Normal par construction :
`world`+`snapshot` voyagent par git, `state.json` (seeds) reste local — le monde
committé (generatedAt 14:09:46Z) a été généré sur une autre machine ; ses seeds sont
là-bas. mtimes probants : world/snapshot = heure du pull (17:24), state = dernier run
local (15:13).
**Conséquence** : tout script qui SIGNE sur le monde committé échoue silencieusement en
`tefBAD_AUTH`/mauvais comptes chez quiconque n'a pas généré ce monde
(`fixtures/test-settlement.mjs`, scripts de démo).
**Règle d'équipe proposée** (à mettre dans le README) :
- l'analyste (Noé) ne consomme QUE `snapshot.json` → jamais impacté ;
- les scripts on-chain qui signent ne tournent QUE sur la machine qui a fait le dernier
  `npm run world` — ou après un `npm run world` local ;
- avant la démo : UNE personne régénère, committe world+snapshot, et fait tourner
  la partie signée depuis SA machine.
**Action faite ici** : monde régénéré en local (gen3) pour la suite de la passe.

## 🟠 2. Sous-score broker « AAA » alors qu'un prêt est défaillable non déclaré (vault `sain`)
Le verdict GLOBAL est correct (« prudence 87/100 » + rouge « défaillable non déclaré »),
mais la ligne broker affiche « note AAA (86.9) FLCR 100 **NPL 100** » : le sous-score
NPL ne compte pas les retards latents (`isLatentDelinquent` existe pourtant dans
`analyst/src/protocol.mjs`). Pour la démo, « AAA » à côté d'un rouge, c'est un message
mixte qu'un juge relèvera. Suggestion pour Noé : faire mordre les latents dans le
sous-score NPL (ou renommer la colonne « NPL déclarés »).

## ℹ️ 3. Script `test` de `main` cassé sous Node 24 (corrigé et poussé)
`node --test <répertoire>` n'est plus accepté par Node 24 (`MODULE_NOT_FOUND`) ; le
script listait `packages/settlement/test` et `packages/orderbook/test` en répertoires.
Corrigé en globs (`'packages/settlement/test/*.test.mjs'`) — commit poussé sur main
par Hugo. À retenir : toujours des fichiers ou des globs dans `--test`.

## ℹ️ 4. Vieillissement du monde — rappel opérationnel
Le monde 14:09Z avait 1h35 au moment de la passe : tous les vaults standards étaient
passés en Redemption et tous les prêts « sains » devenus défaillables. L'analyste
offline reste juste (snapshot figé), mais toute démo live doit régénérer ≤ 15 min
avant (Investment dure 900 s). Déjà en tête de `fixtures/generate.mjs`, répété ici
parce que c'est la première chose qui cassera sur scène.

*(suite de la passe : boucle marché on-chain + CLI sur le monde frais — voir ci-dessous)*

## ✅ 5. La boucle produit complète passe (monde frais gen3, 12/09 ~17:45)
Parcours exécuté de bout en bout, sur Devnet :
1. `npm run world` → 7 vaults, gate non-membre `tecNO_AUTH` ✓, auto-prêt ✓, prêt soldé+`LoanDelete` ✓ ;
2. `npm run cli vaults` → les 7 fiches avec phases live et signaux (3 rouges sur `predateur`, clawback sur `iou`, NAV prudente 0.82 sur `deprecie`) ;
3. `npm run cli sell sain 5000000 4.2` → offre `o003` postée ;
4. `npm run cli book sain.d1` → décote 16 % correctement classée **détresse** (retard latent détecté avant tout mouvement de NAV) ;
5. `npm run cli buy o003 sain.d1` → préflight 10/10, Batch `tesSUCCESS`
   (https://devnet.xrpl.org/transactions/F7BE7C367DCA9F48ED3E55A410BD0F8B5AE5CEE4DB8A342C7A3AB76F12872C33),
   réconciliation exacte 5 000 000 parts ↔ 4,20 XRP, offre marquée exécutée ;
6. `npm run cli history sain` → trade tracé avec prix/part et lien explorer ;
7. `node fixtures/test-settlement.mjs` → 3/3 (swap éligible, gate au préflight,
   et le « Batch menteur » démontré : `tesSUCCESS` avec 0 part bougée, attrapé par la réconciliation).
Tests offline : 98/98. La démo est prête sur cette base.

## ℹ️ 6. Deux miettes relevées en passant
- `orderbook.json` accumule les offres des mondes précédents (o001, o002 pointent des
  vaultIds morts) ; elles sont filtrées à l'affichage mais le fichier grossit à chaque
  régénération. Un nettoyage des offres dont le vaultId n'est plus dans world.json
  serait propre (fichier orderbook = autre conversation, je n'y touche pas).
- `simulate` d'un Batch → `notImpl` côté rippled : déjà géré élégamment par le
  préflight (jambes simulées une à une, assemblage non simulable, signalé en ❔).

## Reste à faire avant la démo (proposition)
1. Régénérer le monde ≤ 15 min avant le passage (et depuis la machine qui pilotera la démo — voir point 1).
2. Trancher le point 2 (sous-score broker vs retards latents) avec Noé.
3. `git add QA-hugo1.md world.json snapshot.json orderbook.json && git commit && git push` si vous voulez partager ce monde — en gardant en tête que seuls CETTE machine pourra signer dessus.
