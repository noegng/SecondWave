# Sondes du marché secondaire — résultats mesurés

Devnet public, `rippled 3.4.0-rc5` (`LendingProtocolV1_1` + `fixCleanup3_4_0`),
`xrpl.js@5.2.0-beta.0`, 12 septembre 2026.

Scripts relançables, dans l'ordre : `01`–`03` (première salve),
`04-escrow-gate-au-denouement.mjs` (gate au dénouement), `04-decor.mjs`
(monde dédié : 5 vaults, 3 domaines, 13 comptes, un IOU, un MPT de numéraire),
puis `05`–`11` (campagnes A–I). Chaque assertion ci-dessous est adossée à des
**soldes avant/après** — jamais au seul code de retour.

---

## 1 · Le rail actuel tient — et ses bords sont maintenant cartographiés

| Question | Mesure | Verdict |
|---|---|---|
| `tfAllOrNothing` annule-t-il tout si une jambe échoue ? | `tesSUCCESS`, meta **1 nœud**, 0 part — vérifié pour l'échec de la jambe prix (13), de la jambe parts (B14), de l'authorize (B15), de l'ordre des jambes (B16) et des séquences internes (B17) | ✅ le rollback est total, quel que soit l'endroit où ça casse |
| Le vendeur peut-il réécrire le prix après signature de l'acheteur ? | `fails local checks: Invalid signature.` | ✅ les `BatchSigners` couvrent les jambes |
| Nombre de jambes | 1 → `temARRAY_EMPTY` (« Array is empty », trompeur) · 2–8 → OK · **9+ → rejet local `invalidTransaction: Batch has too many inner transactions`** | la limite est **8**, découverte à la soumission seulement |
| Une jambe non signée | `temBAD_SIGNER` — « No signer may duplicate account or other signers » | message qui décrit l'inverse du problème (signature *manquante*) |
| `LastLedgerSequence` dépassé | `tefMAX_LEDGER` | échec propre et visible |
| Rejeu d'un Batch validé | `tefPAST_SEQ` | la séquence de l'enveloppe immunise |
| Jambe `Sequence: 0` | `temSEQ_AND_TICKET` | les jambes exigent de vraies séquences |
| Jambe à séquence erronée (trou ou réutilisée) | **`tesSUCCESS` + rollback silencieux** | encore un vecteur d'échec invisible |
| `VaultWithdraw` / `LoanSet` en jambe | `temINVALID_INNER_BATCH` | pas d'échappatoire à la phase Investment |
| Payment interne `Account==Destination` | `temINVALID_INNER_BATCH` | l'auto-paiement est rejeté au protocole |
| Deux Batch concurrents, mêmes parts | `tesSUCCESS` / `tefPAST_SEQ` | la double-vente est impossible, l'échec est propre |

### La sémantique des séquences, mesurée

- Un Batch **entièrement annulé** consomme la séquence de l'**enveloppe** (+1)
  mais **aucune séquence interne** (acheteur +0). Un builder doit resynchroniser
  après tout échec silencieux.
- **Asymétrie décisive** : si le *vendeur* (compte-enveloppe) bouge entre
  signature et soumission → `tefPAST_SEQ`, échec **visible** (C32). Si
  l'*acheteur* (compte interne) bouge → `tesSUCCESS` et rollback **silencieux**
  (H64). Corollaire : l'enveloppe côté vendeur protège tout le monde ; un Batch
  à enveloppe acheteur (H63) fait payer à l'acheteur 150 drops pour un échec
  qu'il ne voit pas.
- **La vraie annulation d'une offre** : un `AccountSet` à vide (10 drops) du
  vendeur invalide tout Batch signé en circulation (F52b). L'annulation du
  carnet hors chaîne est purement décorative (F52a : l'offre « annulée »
  s'est réglée quand même).

---

## 2 · Le piège : trois drapeaux sur quatre livrent sans encaisser

Même échange, jambe du prix volontairement impayable :

| Drapeau | Annoncé | Parts déplacées | Payé |
|---|---|---|---|
| `tfAllOrNothing` | `tesSUCCESS` | **0** | 0 |
| `tfOnlyOne` | `tesSUCCESS` | **300 000** | **0** |
| `tfUntilFailure` | `tesSUCCESS` | **300 000** | **0** |
| `tfIndependent` | `tesSUCCESS` | **300 000** | **0** |
| `Flags: 0` | `temINVALID_FLAG` | 0 | 0 |
| champ `Flags` absent | le SDK refuse de signer : `` No field `flags` `` | — | — |

Oublier le drapeau est impossible. **Choisir le mauvais est indétectable** —
même code, même meta à un nœud, et l'actif est parti.

**La pièce à conviction** — meta d'un Batch `tesSUCCESS` dont aucune jambe n'a
appliqué. Un seul nœud, le prélèvement des frais :

```json
{ "AffectedNodes": [ { "ModifiedNode": {
    "LedgerEntryType": "AccountRoot",
    "FinalFields":    { "Balance": "69499848", "Sequence": 5251320 },
    "PreviousFields": { "Balance": "69499998", "Sequence": 5251319 } } } ],
  "TransactionResult": "tesSUCCESS" }
```

---

## 3 · Campagne A — la mécanique fine du MPT de parts

| Cas | Mesure |
|---|---|
| A1 Payment simple membre→membre | `tesSUCCESS` — le Batch n'apporte QUE l'atomicité du prix |
| A2 vers non-membre auto-autorisé | authorize `tesSUCCESS` puis transfert `tecNO_AUTH` — détenir un `MPToken` ne prouve rien |
| A3 credential émis non accepté | `tecNO_AUTH` |
| A4 credential expiré | `tecNO_AUTH` — l'expiration est vérifiée on-chain |
| A5 credential supprimé | recevoir → `tecNO_AUTH` |
| **A5/D34 vendre après exclusion** | **`tecNO_AUTH` — le gate vérifie AUSSI l'émetteur du transfert. Un détenteur exclu ne peut ni retirer (phase) ni vendre (gate) : enfermé deux fois** |
| A6 vendre 100 % de ses parts | l'objet `MPToken` survit à 0 (0,2 XRP immobilisés jusqu'à `Unauthorize`) · `holderMap` l'exclut · réconciliation OK |
| A7 transfert de 0 part | `temBAD_AMOUNT` |
| A7b au-delà du solde | **`tecPATH_PARTIAL`** (nom hérité des paths IOU — il n'y a aucun path ici) |
| A8 double authorize | `tecDUPLICATE` — le carnet doit tolérer ce code |
| A9 unauthorize avec solde | `tecHAS_OBLIGATIONS` |
| A10 TransferFee | **absent** de l'issuance — un échange secondaire ne reverse rien au vault, et rien ne permet d'en ajouter |
| A11 vault non transférable | shareFlags=**4** : les bits CAN_ESCROW et CAN_TRADE disparaissent AUSSI · Payment → `tecNO_AUTH` · EscrowCreate → `tecNO_PERMISSION` (deux codes pour la même cause) |
| A12 détruire ses parts | Payment vers le pseudo-compte → `tecNO_PERMISSION` · `MPTokenIssuanceDestroy` par un détenteur → `tecNO_PERMISSION` |
| Cross-currency / Paths sur MPT | `temMALFORMED` — un Payment MPT est strictement direct (mais `tfPartialPayment` est accepté) |

## 4 · Campagne D — l'éligibilité côté marché

| Cas | Mesure |
|---|---|
| D33 credential supprimé avant exécution | le swap meurt (`tecNO_AUTH` sur la jambe) — rollback |
| D35 le domaine **mute** ses `AcceptedCredentials` | l'exécution suit le domaine **courant** : un acheteur éligible à l'offre peut être inéligible au règlement |
| D36 membre d'un autre domaine | `tecNO_AUTH` — pas de transitivité |
| D37 vault public | swap complet `tesSUCCESS` avec un compte **sans aucun credential** — le marché d'un vault public est ouvert à tous |
| D38 deux vaults, même domaine | un seul credential ouvre les deux marchés |
| D39 annotations du carnet | exactes (non-transférable / credential manquant / offre morte) mais **pas actionnables** : elles ne disent pas quel credential obtenir ni auprès de qui |

`MPTokenAuthorize` n'est pas gaté (05/A2) : la présence d'un `MPToken` ne prouve
rien sur l'éligibilité — un carnet qui en déduirait le droit d'acheter se
tromperait. Et le même `tecNO_AUTH` signifie tantôt « pas d'objet MPToken »,
tantôt « pas membre du domaine » : indiscernables sans lecture d'état.

## 5 · Campagne C — le preflight et ses trous

- **C27** : les 7 contrôles se déclenchent chacun correctement, aucun faux positif.
- **C28a — faux négatif trouvé** : le preflight ne vérifie jamais l'éligibilité
  du **vendeur**. Vendeur exclu + acheteur sans `MPToken` (donc `simulate` porte
  sur l'authorize, pas le transfert) → preflight `ok=true`, Batch `tesSUCCESS`,
  0 part livrée.
- **C28b** : des parts engagées en escrow sont débitées du `MPToken` dès le
  `EscrowCreate` → un preflight **ré-exécuté** voit le trou. Le risque est
  entièrement dans les offres du carnet non revalidées.
- **C29** : `simulate` fonctionne sur chaque jambe isolée mais renvoie
  **`notImpl` sur un Batch** — la transaction dont dépend tout le produit est la
  seule qu'on ne peut pas simuler.
- **C30/31 — le seuil exact, au drop près** : l'acheteur doit conserver, après
  paiement, `base (1 XRP) + 0,2 × (OwnerCount + 1)` — l'objet `MPToken` à créer
  compte **avant** que le prix parte. À ce seuil : livré. **Un drop de moins :
  `tesSUCCESS` et rien ne bouge.** La marge forfaitaire de 2 XRP du preflight
  est sûre mais opaque ; la formule exacte est meilleure.
- **C32** : course vendeur → `tefPAST_SEQ` (propre, §1) ; course acheteur →
  silencieuse. La réconciliation des soldes reste le seul juge de paix.

## 6 · Campagne E — la découverte de prix

- **E40** : 5 échanges à prix distincts → `priceHistory` les retrouve **tous,
  dans l'ordre, aux bons prix** (0,80 → 0,91 drop/part).
- **E41 — le prix en n'importe quel numéraire** : parts↔IOU `tesSUCCESS`,
  parts↔MPT `tesSUCCESS` (**swap MPT contre MPT entièrement atomique**). Mais :
  - le chemin IOU a échoué **trois fois silencieusement** avant de marcher :
    `tecPATH_DRY` (issuer sans `DefaultRipple`), toujours `tecPATH_DRY` après
    `asfDefaultRipple` (le flag ne nettoie pas les lignes existantes), succès
    seulement après un `TrustSet tfClearNoRipple` **par ligne**. Dans un Batch,
    chacun de ces échecs est un `tesSUCCESS` à un nœud.
  - `priceHistory` ne lit que l'XRP : ces trades ressortent à prix `null`.
- **E42** : une donation ressort à prix `null`, jamais 0 — pas de pollution des moyennes.
- **E43** : un règlement en deux tx sur des ledgers différents est invisible
  (`counterLeg` ne regarde que le même ledger) — limite documentée.
- **E44/I69** : après un flood de **240 transferts (240/240 appliqués, 67 s,
  jusqu'à 16 tx/ledger)**, le pseudo-compte dépasse une page d'`account_tx` ;
  `holderMap` (800 ms) et `priceHistory` restent complets et réconciliés. Mais
  `priceHistory` fait **un `account_tx` par transfert** : 251 transferts →
  45,9 s. O(n) en RPC — inutilisable au-delà de quelques centaines de trades
  sans cache.
- **E45** : décote moyenne 13,8 % sur un vault sans prêt — pur prix de
  l'illiquidité ; 12,1 % sur le monde initial (13 % d'actifs prêtés).
- **E46** : courbe de décote reconstruite on-chain sur un vault court :
  0,965 → 0,975 → 0,985 → 0,992 × NAV en s'approchant de `RedemptionDate`.
  La convergence vers la NAV est mesurable, ledger par ledger.

## 7 · Campagne F — le carnet

| Cas | Mesure |
|---|---|
| F47 partiel | inexistant : une prise partielle laisse l'offre `open` à taille pleine — protocole d'usage : `fill()` + re-post du reliquat (200 drops par fraction, linéaire) |
| **F48 survente en cumul** | **deux offres de 60 % du solde affichées toutes deux `eligible` — la couverture n'est vérifiée qu'offre par offre** |
| F49 offre morte | détectée par `viewFor` avec le solde restant en clair (« le vendeur n'a plus que 1 283 334 parts ») |
| F50 expiration | frontière stricte correcte, mais calculée sur l'**horloge locale** — deux clients désynchronisés voient deux carnets |
| **F51 double règlement** | `fill()` écrase status et `txHash` sans vérifier — la preuve on-chain du vrai acheteur est perdue |
| F52 annulation | `cancel()` hors chaîne n'empêche rien ; la vraie annulation est le bump de séquence (§1) |

## 8 · Campagne G — les rails de règlement, comparés

| Rail | État | Détail |
|---|---|---|
| **Batch `tfAllOrNothing`** | ✅ le rail nominal | 1 tx, 150–200 drops, atomicité prouvée dans tous les cas d'échec testés |
| **Deux escrows conditionnés (HTLC)** | ✅ **rail complet, non documenté** | 4 tx `tesSUCCESS`, ~1 000 drops/partie + 0,2 XRP de réserve d'escrow chacune, le secret se relit on-chain |
| Payment direct + confiance | ✅ passe | aucune protection — c'est ce que le produit remplace |
| `CheckCreate` MPT | ❌ | `invalid SendMax` (rejet local) |
| `PaymentChannelCreate` MPT | ❌ | `Amount must be a string` (rejet local) |
| `OfferCreate` DEX | ❌ | `temDISABLED` — le code existe, l'amendement (XLS-82) est éteint |
| `NFTokenCreateOffer` | ❌ | « Amount can not be MPT » (rejet local) |

### L'escrow de parts, en détail (sondes 03, 04 et 08)

| Sonde | Résultat |
|---|---|
| **HTLC complet** : escrow parts + escrow XRP, même condition, dénouement croisé | **4 × `tesSUCCESS`, 1 000 000 parts contre 0,9 XRP, atomicité par le secret, zéro Batch** |
| Le secret est-il réutilisable par la contrepartie ? | oui — relu dans le champ `Fulfillment` de la tx validée, identique au bit près |
| Gate du domaine au **Create** | `tecNO_AUTH` vers un non-membre |
| Gate au **Finish** (destinataire exclu entre-temps) | **`tecNO_AUTH` — re-vérifié au dénouement** ; l'escrow reste au ledger jusqu'au `CancelAfter` |
| ⭐ Destinataire **sans `MPTokenAuthorize`** | `EscrowFinish` → `tesSUCCESS`, **l'objet `MPToken` est créé automatiquement** — une jambe de moins qu'au Batch, et le faux négatif du preflight disparaît |
| `EscrowFinish` par un **tiers** étranger | `tesSUCCESS` — le règlement est délégable (pattern relayer) |
| `EscrowCancel` | rend l'intégralité des parts ; soumis par n'importe qui après `CancelAfter` |
| Escrow **sans Destination** | champ obligatoire — pas d'offre « au porteur » : l'escrow est un engagement bilatéral, pas un carnet |
| Escrow vers soi-même | `tesSUCCESS` (anecdotique) |
| Vault public → outsider | create + finish `tesSUCCESS` |
| Comptabilité | `MPToken` du vendeur débité au Create **et** champ `LockedAmount` sur le `MPToken` et sur l'issuance ; `OutstandingAmount` inchangé |
| **Sans `CancelAfter` + destinataire exclu** | **Finish `tecNO_AUTH` + Cancel `tecNO_PERMISSION` = parts gelées À PERPÉTUITÉ** (voir SECURITY-NOTES) |
| Smart Escrow `FinishFunction` | **inexprimable** : « Field FinishFunction is not defined in the definitions » — `ripple-binary-codec@2.11.0` ignore le champ |

### Batch vs escrow — le tableau de décision

|  | Batch `tfAllOrNothing` | Escrow de parts |
|---|---|---|
| Transactions | **1** | 2 à 4 |
| Atomicité prix ↔ parts | **native** | par condition partagée (HTLC) |
| L'offre existe on-chain | non | **oui, objet du ledger** |
| Autorisation préalable de l'acheteur | requise (jambe 1) | **inutile — `MPToken` auto-créé** |
| Expiration | aucune (convention hors chaîne) | **`CancelAfter`, appliquée par le ledger** |
| Contrepartie | libre jusqu'à la soumission | nommée à la création |
| Gate du domaine | à l'exécution | **à la création ET au dénouement** |
| Rétractation du vendeur | bump de séquence (10 drops) | seulement après `CancelAfter` |

## 9 · L'économie du rail (au drop près)

| Mesure | Valeur |
|---|---|
| Swap 3 jambes (authorize + parts + prix) | **200 drops**, payés par le vendeur (enveloppe) ; 150 drops à 2 jambes |
| Coût pour l'acheteur | **0 drop de fee** ; **200 000 drops de réserve** immobilisés par l'objet `MPToken` (récupérables via `Unauthorize` après revente totale) |
| Seuil de solvabilité acheteur | solde ≥ prix + 1 XRP + 0,2 × (OwnerCount+1) — vérifié au drop près, échec **silencieux** un drop en dessous |
| Échec silencieux | coûte le Fee de l'enveloppe (150–200 drops) |
| HTLC double escrow | ~1 000 drops par partie (finish conditionnel à fee majoré) + 0,2 XRP de réserve par escrow pendant le blocage |
| Vente fractionnée | linéaire — chaque fraction paie son enveloppe |
| Décote observée | 12–14 % selon le vault — **~800 × le coût du rail** : la friction de ce marché est le prix de l'illiquidité, pas la technique |
| Débit | 240 transferts en 67 s (8/compte/ledger), 0 rejet, max 16 tx/ledger observé sur le flux |
| `holderMap` à 23 détenteurs | 440 ms — le coût est en pages d'`account_tx`, pas en détenteurs |
| `AccountDelete` d'un détenteur | bloqué — mais le message énumère « Escrows, PayChannels, RippleStates, Checks, or Sponsorships » **sans mentionner les MPToken**, qui sont la vraie cause |

---

## 10 · Recommandation — le Batch est-il le bon rail ?

**Oui pour l'exécution, avec quatre règles absolues**, et l'escrow en second
rail pour un autre usage.

1. **`tfAllOrNothing` forcé, jamais paramétrable.** Trois drapeaux sur quatre
   livrent l'actif sans le prix, avec un retour identique au succès.
2. **La réconciliation des soldes est le protocole**, pas une vérification de
   confort : `tesSUCCESS` ne dit rien, la meta ne dit rien, `simulate` refuse
   les Batch. C'est la conception actuelle du `SettlementEngine` — validée.
3. **Enveloppe côté vendeur, toujours.** Elle transforme la moitié des courses
   en `tefPAST_SEQ` propres et donne au vendeur un droit d'annulation réel
   (bump de séquence à 10 drops) — à exposer comme fonctionnalité du carnet.
4. **Compléter le preflight** : éligibilité du **vendeur** (C28a), formule de
   réserve exacte au lieu de la marge forfaitaire, revalidation de l'offre au
   moment du règlement (F48/F49).

**L'escrow n'est pas un remplaçant, c'est l'étage au-dessus** : une promesse
*ferme* et *visible on-chain* envers un acheteur nommé — la forme exacte d'une
négociation de gré à gré sur du crédit privé (fenêtre de due diligence,
échéance opposable, DvP sans présence simultanée, et une jambe d'autorisation
en moins). Ses limites : bilatéral (pas d'offre au porteur), 2–4 tx, timings
HTLC à concevoir avec soin, et **toujours poser `CancelAfter`** sous peine de
gel perpétuel. Le pitch tient en une ligne : *Batch pour le marché, escrow
pour le contrat.*
