# Les deux rails de règlement

Ce qu'on relira dans six mois. Tout ce qui suit est mesuré sur le Devnet public
(`rippled 3.4.0-rc5`, `xrpl.js@5.2.0-beta.1`), pas déduit d'une documentation.

```js
settle(client, { rail: 'batch' | 'htlc', vaultId, sellerWallet, buyerWallet, shares, price })
  → { ok, rail, stage, moved, evidence, cost, warning, before, after, preflight }
```

Même forme de résultat des deux côtés, et **la réconciliation des soldes dans les
deux cas**. Ce n'est pas une option : sur ce réseau, un `Batch` renvoie
`tesSUCCESS` alors qu'aucune jambe n'a appliqué, sa meta ne contient que la
ponction de frais, et `simulate` répond `notImpl` dessus. Le code de retour ment ;
les soldes non.

---

## Lequel utiliser

| | `batch` | `htlc` |
|---|---|---|
| **À utiliser pour** | **le marché** : deux parties d'accord, disponibles, réglées tout de suite | **le contrat** : un engagement ferme envers un acheteur nommé, avec une échéance |
| Transactions | **1** | 4 |
| Atomicité | native (`tfAllOrNothing`) | par la condition partagée |
| L'offre existe on-chain | non — une signature hors chaîne | **oui — un objet du ledger** |
| Contrepartie | libre jusqu'à la soumission | **nommée dès la création** |
| Autorisation préalable de l'acheteur | requise (jambe 1) | **inutile — `EscrowFinish` crée l'objet `MPToken`** |
| Expiration | aucune (convention hors chaîne) | **`CancelAfter`, opposable par le ledger** |
| Les deux parties doivent être en ligne | oui, au même instant | non — le vendeur agit, l'acheteur suit quand il veut |
| Rétractation du vendeur | bump de séquence (10 drops) | seulement après `CancelAfter` |
| Gate du domaine vérifié | à l'exécution | **à la création ET au dénouement** |

En une ligne : **`batch` pour le marché, `htlc` pour le contrat.**

Le rail HTLC n'est pas un carnet d'offres : `Destination` est obligatoire, donc
une offre au porteur est impossible. C'est la forme exacte d'une cession de gré à
gré sur du crédit privé — fenêtre de due diligence, échéance opposable, livraison
contre paiement sans présence simultanée.

---

## Le coût, au drop près

Mesuré le 12 septembre 2026, réserves Devnet `base 1 XRP`, `inc 0,2 XRP`.

| | `batch` | `htlc` |
|---|---|---|
| Frais totaux | **150 drops** (2 jambes) · **200 drops** (3 jambes) | **2 002 drops** sur 4 transactions |
| Qui paie | le vendeur (l'enveloppe) | ~1 001 drops chacun |
| Réserve immobilisée | 0,2 XRP chez l'acheteur (objet `MPToken`) | 0,2 XRP par escrow **pendant** l'échange, rendus au dénouement, + 0,2 XRP d'objet `MPToken` |
| Coût d'un échec | le Fee de l'enveloppe (150–200 drops), **silencieusement** | les frais des étapes déjà passées ; les dépôts reviennent par `refund` |

Les frais du HTLC sont dominés par les deux `EscrowFinish` conditionnels. La
règle `base × (33 + ⌈octets/16⌉)` n'est appliquée par aucun autofill du SDK :
`conditionalFinishFee()` la calcule, la double, et plancher à **1 000 drops**
(valeur mesurée qui passe). C'est conservateur — le minimum réel tourne autour de
360 drops ; à optimiser si le volume le justifie.

Pour mémoire, la décote de marché observée est de 12 à 14 %. **Le coût du rail
est inférieur d'un facteur ~800 à la décote** : la friction de ce marché n'est pas
technique, elle est entièrement dans le prix de l'illiquidité.

---

## 🔴 Le décalage des `CancelAfter` — la seule pièce de sécurité du HTLC

Deux escrows portent la **même** condition `PreimageSha256`. Le vendeur détient le
secret, donc **il agit toujours en premier** :

```
1. propose   le vendeur bloque les PARTS   CancelAfter = T_parts
2. accept    l'acheteur bloque le PRIX     CancelAfter = T_prix   (même condition)
3. claim     le vendeur dénoue le PRIX en révélant le secret      → il est payé
4. settle    l'acheteur relit le secret on-chain et dénoue les PARTS → il est livré
```

Le vendeur choisit l'instant de l'étape 3. L'étape 4 ne peut avoir lieu qu'après.

**Si `T_prix ≥ T_parts`**, le vendeur attend la dernière seconde avant `T_parts`,
encaisse le prix, et l'acheteur n'a plus le temps de dénouer les parts : il a payé
et ne reçoit rien. C'est la faille classique du HTLC, et elle est silencieuse.

D'où la règle, appliquée par `planTimings()` et vérifiée par `validateTimings()`
avant que l'acheteur n'engage un drop :

```
T_prix + MARGE ≤ T_parts          MARGE ≥ 120 s
```

La marge est le temps dont dispose l'acheteur, après le dernier instant où le
vendeur a pu encaisser, pour observer la révélation et soumettre son propre
`EscrowFinish`. Un ledger se ferme en ~4 s sur le Devnet : 120 s laissent une
trentaine de ledgers. `accept()` refuse tout couple qui ne respecte pas la règle —
il n'y a pas de mode « je sais ce que je fais ».

### `CancelAfter` est obligatoire, pas recommandé

Un escrow de parts **sans `CancelAfter`** dont le destinataire perd son credential
est **irrécupérable à jamais** : `EscrowFinish` → `tecNO_AUTH` (le gate est
réévalué au dénouement), `EscrowCancel` → `tecNO_PERMISSION` (pas d'échéance),
et l'objet reste au ledger indéfiniment. Reproduit de bout en bout.

`propose()` lève plutôt que de construire un tel escrow. Ne pas « assouplir ».

---

## Les moyens de paiement

`price` accepte les trois formes d'`Amount` d'XRPL, normalisées par
`normalizeAmount()` :

| | forme | ce que le preflight vérifie |
|---|---|---|
| XRP | `'880000'` (drops) | le seuil de solvabilité exact (ci-dessous) |
| IOU | `{ currency, issuer, value }` | trustline des **deux** côtés, gel, limite, **et le rippling chez l'émetteur** |
| MPT | `{ mpt_issuance_id, value }` | `CAN_TRANSFER` sur l'issuance, solde du payeur, objet `MPToken` du bénéficiaire |

**Le piège de l'IOU**, payé trois fois avant d'être compris : une trustline
ouverte avant que l'émetteur n'active le rippling porte `NoRipple` du côté de
l'émetteur, et le paiement meurt en `tecPATH_DRY` — donc, dans un `Batch`, en
`tesSUCCESS` avec une meta à un nœud. **`asfDefaultRipple` ne rattrape pas les
lignes déjà ouvertes** : il faut un `TrustSet tfClearNoRipple` de l'émetteur sur
**chaque** ligne. Le preflight le détecte et donne le correctif dans le message.

`priceHistory()` relit les trois numéraires. Compatibilité : `price` reste la
chaîne de drops pour un prix en XRP (et `null` sinon) ; `priceAmount`,
`priceLabel` et `priceKind` portent les autres. *(Conséquence : `apps/cli history`
affiche « prix introuvable » sur un échange en IOU tant qu'il n'a pas été branché
sur `priceLabel` — un mot à changer, côté CLI.)*

---

## Le seuil de solvabilité de l'acheteur

Mesuré au drop près :

```
solde_après_paiement  ≥  base + inc × (OwnerCount + objets_créés)
```

L'objet `MPToken` que la jambe d'autorisation va créer compte **avant** que le
prix ne parte. À ce seuil exact, les parts sont livrées ; **un drop en dessous,
`tesSUCCESS` et rien ne bouge**, sans qu'aucun `tec` ne remonte jamais.
`buyerSolvency()` applique la formule ; l'ancienne marge forfaitaire de 2 XRP
était sûre mais refusait des acheteurs solvables sans rien expliquer.

---

## Ce que le preflight ne peut pas faire

- **Simuler le `Batch`** : `simulate` répond `notImpl`. Les jambes sont simulées
  séparément et le résultat porte un contrôle `simulate du Batch` explicitement
  marqué « impossible » — on préfère le dire que le laisser croire.
- **Empêcher une course** : entre le preflight et la soumission, tout peut
  bouger. Si c'est le **vendeur** qui bouge, l'échec est propre (`tefPAST_SEQ`,
  sa séquence porte l'enveloppe) ; si c'est l'**acheteur**, l'échec est
  silencieux. C'est la raison pour laquelle l'enveloppe est portée par le
  vendeur, et elle ne doit pas être inversée.
- **Annuler une offre déjà signée** : un `cancel()` du carnet ne touche qu'un
  fichier. La seule annulation opposable est un bump de séquence du vendeur
  (`AccountSet` à vide, 10 drops), qui invalide tout `Batch` en circulation.

---

## Les scripts de vérification

```
npm test                                          # 39 tests hors ligne (logique pure)
node packages/settlement/scripts/batch.mjs        # nominal + acheteur à 1 drop du seuil
node packages/settlement/scripts/htlc.mjs         # les 4 étapes + refund après expiration
node packages/settlement/scripts/iou.mjs          # le piège du rippling, sa réparation, le swap
npm run test:rails                                # les trois d'affilée
npm run test:matrice                              # ⭐ la matrice PUBLIC × PRIVÉ : 18 contrôles
                                                  #    XLS-33/56/65/80/85 via les vrais packages,
                                                  #    décor autonome (immunisé contre la
                                                  #    désynchronisation world/state — QA-hugo1 §1)
```

Un angle mort assumé, mesuré par la matrice (P7) : **un échange réglé sur le
rail HTLC est invisible de `priceHistory`** — la livraison est un `EscrowFinish`,
pas un `Payment`, et l'historique ne lit que les `Payment`. Tant que le rail
HTLC sert au gré à gré, c'est cohérent (un contrat privé n'est pas un prix de
marché) ; si on veut l'y intégrer un jour, il faudra relire aussi les
`EscrowFinish` du pseudo-compte.

Chacun imprime les soldes avant et après. ⚠️ Ils tournent sur les comptes du
monde de démo, qui sont **partagés** avec les autres sessions : les assertions
portent sur des deltas autour d'une transaction, jamais sur des soldes absolus.
