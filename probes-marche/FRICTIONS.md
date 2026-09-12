# Frictions développeur — marché secondaire de parts de vault

Format : **catégorie** · **titre** · description · repro · **sévérité** · lib/version.
Environnement commun : Devnet public, `rippled 3.4.0-rc5` (`LendingProtocolV1_1`,
`fixCleanup3_4_0`), `xrpl.js@5.2.0-beta.0`, `ripple-binary-codec@2.11.0`.
Les repros pointent vers `probes-marche/*.mjs` (scripts autonomes).

---

## Sévérité haute

**1 · other (rippled)** · **`Batch` renvoie `tesSUCCESS` quand rien ne s'applique, et sa meta ne le dit pas**
Un `Batch tfAllOrNothing` dont toutes les jambes échouent valide `tesSUCCESS`
avec une meta à un seul nœud (le Fee). Le `BatchExecutions` promis par XLS-56
est absent. Aucun champ ne distingue « tout appliqué » de « rien appliqué » :
la seule vérité est la comparaison des soldes avant/après, et les jambes ne se
retrouvent que par `account_tx` sur `[ledgerIndex, ledgerIndex]`. Nous avons
mesuré **sept** chemins d'échec silencieux distincts (prix impayable, vendeur à
découvert, MPT inexistant, mauvais ordre des jambes, séquence interne erronée,
course sur l'acheteur, réserve à 1 drop près).
Repro : `01-atomicite-et-rails.mjs` sonde 1 · `06-batch.mjs` B14–B17 · `06b`.
Sévérité : **haute**. `rippled 3.4.0-rc5`.

**2 · UX (protocole)** · **Trois drapeaux de Batch sur quatre livrent l'actif sans le prix — indétectablement**
Sur le même swap à jambe de prix impayable : `tfOnlyOne`, `tfUntilFailure` et
`tfIndependent` transfèrent les parts SANS paiement, avec exactement le même
retour (`tesSUCCESS`, meta 1 nœud) que le rollback de `tfAllOrNothing`. Le
choix du drapeau est la différence entre un échange et une perte sèche, et rien
dans la réponse ne le signale.
Repro : `01-atomicite-et-rails.mjs` sonde 4 (matrice complète).
Sévérité : **haute**. `rippled 3.4.0-rc5`.

**3 · missing primitive** · **`simulate` refuse les `Batch` (`notImpl`)**
Chaque jambe se simule individuellement, mais la transaction composée — celle
dont dépend tout produit de règlement atomique — renvoie `notImpl`. Impossible
de dry-runner un swap : il faut le soumettre et payer pour savoir.
Repro : `07-preflight.mjs` C29.
Sévérité : **haute**. `rippled 3.4.0-rc5`.

**4 · other (design XLS-65/permissioned domains)** · **Un détenteur exclu du domaine est enfermé deux fois**
Le gate vérifie l'émetteur ET le destinataire d'un `Payment` de parts. Un
détenteur dont le credential expire ou est supprimé pendant la phase Investment
ne peut ni retirer (`VaultWithdraw` bloqué par la phase) ni **vendre**
(`tecNO_AUTH` même vers un membre valide). Sa position est gelée jusqu'à ce que
l'émetteur de credential le réintègre. Pour un produit de sortie de secours,
c'est exactement la population qui en a besoin qui en est privée — mérite une
discussion de design (le transfert *sortant* devrait-il être permis ?).
Repro : `05-mpt-eligibilite.mjs` D34.
Sévérité : **haute** (produit) · comportement protocole cohérent mais surprenant.

**5 · documentation/tutorials** · **L'escrow de MPT fonctionne, jusqu'au HTLC complet — et rien ne le documente**
`EscrowCreate` accepte les parts de vault (bit CAN_ESCROW posé par
`VaultCreate`), les débite immédiatement, expose `LockedAmount` sur le
`MPToken` et l'issuance, re-vérifie le gate du domaine au `Finish`, crée le
`MPToken` du destinataire automatiquement, et deux escrows liés par la même
condition `PreimageSha256` forment un échange atomique sans `Batch`. Aucun de
ces comportements n'est documenté ; le piège dual (escrow sans `CancelAfter`
vers un destinataire exclu = gel perpétuel) non plus.
Repro : `08-escrow-rail.mjs` E1–E8 · `04-escrow-gate-au-denouement.mjs`.
Sévérité : **haute** (c'est un rail entier, découvert à l'aveugle).

---

## Sévérité moyenne

**6 · client libraries** · **`FinishFunction` (Smart Escrow, XLS-100) inexprimable avec le SDK**
`ripple-binary-codec@2.11.0` (embarqué dans `xrpl.js@5.2.0-beta.0`) ne connaît
pas le champ : « Field FinishFunction is not defined in the definitions ».
Impossible de tester le Smart Escrow sur le Devnet avec la lib imposée.
Repro : `08-escrow-rail.mjs` E4. Sévérité : **moyenne**. `xrpl.js@5.2.0-beta.0`.

**7 · UX (rippled)** · **Codes et messages trompeurs, rencontrés en une seule journée**
- `temARRAY_EMPTY` « Array is empty » pour un Batch à **1** jambe (le minimum est 2) ;
- `temBAD_SIGNER` « No signer may duplicate account or other signers » pour une
  signature **manquante** ;
- `tecPATH_PARTIAL` pour un découvert MPT (aucun path en jeu) ;
- `tecNO_AUTH` signifie indifféremment « pas d'objet MPToken », « pas membre du
  domaine », « credential expiré » et « credential non accepté » ;
- la limite de **8 jambes** n'existe qu'en rejet local `invalidTransaction`
  (« too many inner transactions ») — invisible avant soumission ;
- `AccountDelete` bloqué par un MPToken énumère « Escrows, PayChannels,
  RippleStates, Checks, or Sponsorships » sans mentionner les MPToken ;
- Payment de parts non transférables → `tecNO_AUTH`, mais EscrowCreate des
  mêmes parts → `tecNO_PERMISSION` : deux codes pour la même cause.
Repro : `05`, `06`, `08`, `11`. Sévérité : **moyenne**. `rippled 3.4.0-rc5`.

**8 · other (rippled)** · **La réserve de l'acheteur échoue silencieusement à 1 drop près**
L'objet `MPToken` créé par la jambe d'autorisation compte dans la réserve
AVANT que la jambe de prix parte : l'acheteur doit garder
`base + inc × (OwnerCount+1)` après paiement. Un drop de moins → `tesSUCCESS`
et zéro mouvement. Aucun `tec` ne remonte jamais.
Repro : `07b-reserve-exacte.mjs`. Sévérité : **moyenne**. `rippled 3.4.0-rc5`.

**9 · documentation/tutorials** · **Un prix en IOU dans un Batch : trois échecs silencieux avant le premier succès**
`tecPATH_DRY` si l'issuer n'a pas `DefaultRipple` ; poser `asfDefaultRipple`
après coup ne suffit pas (les lignes existantes gardent NoRipple) ; il faut un
`TrustSet tfClearNoRipple` **par ligne**. Dans un Batch, chaque étape ratée est
un `tesSUCCESS` à un nœud. Le swap MPT↔MPT, lui, marche du premier coup.
Repro : `09-prix.mjs` E41 + transcript. Sévérité : **moyenne**.

**10 · client libraries** · **API v2 : `Amount` devient `DeliverMax` dans les réponses, silencieusement**
Tout code qui lit `tx.Amount` sur une transaction relue (`tx`, `account_tx` —
y compris les jambes internes d'un Batch) voit `undefined`. Nous avons dû
centraliser un helper `payAmount()`.
Repro : `packages/core` payAmount. Sévérité : **moyenne**. `xrpl.js@5.2.0-beta.0`.

**11 · missing primitive** · **Ni `mpt_holders`, ni historique de prix : tout se reconstruit par rejeu**
Pas de RPC pour énumérer les détenteurs d'une issuance MPT ni pour lire les
échanges : `holderMap` rejoue l'`account_tx` du pseudo-compte (auto-vérifié
contre `OutstandingAmount`), et `priceHistory` fait **un `account_tx` par
transfert** pour retrouver la contre-jambe — 251 transferts = 45,9 s. O(n) en
RPC, impraticable au-delà de quelques centaines de trades.
Repro : `11-echelle.mjs` E44. Sévérité : **moyenne**. `rippled 3.4.0-rc5`.

---

## Sévérité basse

**12 · client libraries** · **Batch sans `Flags` : le SDK refuse avec un message brut**
`` Error: No field `flags` `` (champ en minuscules, pas d'explication). Le
garde-fou est bienvenu, le message non actionnable.
Repro : `03-escrow-et-drapeau-par-defaut.mjs` A1. Sévérité : **basse**. `xrpl.js@5.2.0-beta.0`.

**13 · documentation/tutorials** · **Fee des `EscrowFinish` conditionnels non autofillé**
Le fee majoré (330 drops + 10/16 octets de fulfillment) doit être calculé à la
main ; l'autofill propose le fee de base et le nœud rejette.
Sévérité : **basse**. `xrpl.js@5.2.0-beta.0`.

**14 · other** · **`MPTokenAuthorize` n'est pas gaté par le domaine**
Un compte sans credential peut créer un `MPToken` pour les parts d'un vault
privé (`tesSUCCESS`) — seul le transfert est bloqué. Inoffensif en pratique
(0,2 XRP de réserve à sa propre charge), mais un carnet qui déduirait
l'éligibilité de la présence d'un `MPToken` se tromperait.
Repro : `01` sonde 3b, `05` A2. Sévérité : **basse**.

---

## Ce qui mérite des éloges (feedback positif, à transmettre aussi)

- **L'atomicité de `tfAllOrNothing` n'a cassé sur aucun des ~15 vecteurs
  testés** — jambe par jambe, séquences, ordres, courses, réserves.
- Les `BatchSigners` couvrent réellement les jambes : toute altération
  post-signature meurt en `Invalid signature`.
- Le gate des permissioned domains est **étanche et réévalué partout** :
  Payment, EscrowCreate, EscrowFinish, mutation du domaine incluse.
- `LockedAmount` sur MPToken/issuance pendant un escrow : exactement la donnée
  qu'un carnet veut lire (elle mériterait juste d'être documentée).
- Le Devnet a encaissé 240 transferts pré-séquencés en 67 s sans un seul rejet.
