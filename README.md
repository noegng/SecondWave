# SecondWave

**Un marché secondaire pour les positions de vault verrouillées, avec un analyste de risque intégré.**

| | |
|---|---|
| **Track** | 2 — Lending Protocol · **flavour** Loaded (Permissioned Domains + Credentials) |
| **Réseau** | Devnet public XRPL — `wss://s.devnet.rippletest.net:51233` |
| **rippled** | 3.4.0-rc5 — `LendingProtocolV1_1`, `BatchV1_1`, `fixCleanup3_4_0` actifs |
| **Lib** | `xrpl.js@5.2.0-beta.1` · `ripple-binary-codec@2.11.0` · Node ≥ 20 |
| **Explorer** | https://devnet.xrpl.org |
| **Équipe** | BFT-PARIS-26 |

---

## Le problème

Un vault **closed-ended** enferme le capital. Pendant toute la phase Investment,
`VaultWithdraw` répond `tecTOO_SOON` : un déposant qui a besoin de son argent —
appel de marge, changement de mandat, besoin de trésorerie — **n'a aucune issue**
jusqu'à la `RedemptionDate`.

Pire, pendant cet enfermement le risque peut se dégrader **sans que le prix ne
bouge**. `AssetsTotal` ne change qu'au moment où le courtier déclare un impairment
ou un défaut, et **rien ne l'y oblige**. Un prêt dont l'échéance et le délai de
grâce sont dépassés depuis des heures laisse la NAV parfaitement intacte.

## Ce que fait SecondWave

Les parts d'un vault sont un MPT (XLS-33) : elles se transfèrent. La sortie existe
donc déjà, elle n'est simplement pas outillée. SecondWave l'outille, en trois
briques :

**Un carnet d'offres** — un déposant enfermé propose ses parts à un prix. Le carnet
n'affiche à un acheteur que ce qu'il peut réellement recevoir, et quand une offre
lui est inaccessible, il dit *pourquoi*.

**Un règlement atomique** — parts et prix changent de main ensemble ou pas du tout,
via un `Batch` `tfAllOrNothing`. Avec, au-dessus, trois couches de vérification :
un preflight qui refuse d'envoyer ce qui échouera, la reconstruction du compte
rendu d'exécution que le protocole ne fournit pas, et la réconciliation des soldes.

**Un analyste** — le vendeur brade toujours un peu. Toute la question est de savoir
*pourquoi*. L'analyste distingue une **décote de liquidité** — le fonds va bien, le
vendeur a besoin de cash, c'est une opportunité — d'une **décote de détresse** — le
fonds va mal et ça ne se voit pas encore. Rien sur la chaîne ne les sépare : deux
offres au même prix peuvent être une aubaine et un piège.

---

## Démarrage rapide

```bash
git clone <ce-dépôt> && cd SecondWave
npm install
npm test                    # 98 tests, hors ligne
```

### Générer un monde de test sur le Devnet

```bash
npm run world               # ~12 min : comptes, credentials, domaine, 7 vaults, prêts
```

Écrit trois fichiers : `world.json` (identifiants publics, committé),
`state.json` (**seeds — gitignoré**) et `snapshot.json` (l'état figé de chaque
vault, committé).

> ⚠️ **Le monde vieillit.** Les échéances de prêt tombent toutes les 120 s : un
> monde généré il y a une heure a tous ses prêts en retard. Régénérer peu avant
> toute démonstration.

### La démonstration

```bash
npm run cli vaults                    # les vaults, notés par l'analyste
npm run cli sell sain 3000000 2.6     # publier une offre
npm run cli book sain.d1              # le carnet vu par un acheteur donné
npm run cli buy o001 sain.d1          # analyse → preflight → règlement → réconciliation
npm run cli history sain              # l'historique des prix, relu on-chain
```

### L'analyste, hors ligne

```bash
npm run analyse                       # liste les vaults de snapshot.json
npm run analyse -- predateur          # note un vault, sans réseau ni faucet
```

### Les rails de règlement

```bash
npm run test:rails                    # Batch · HTLC (deux escrows conditionnés) · IOU
```

---

## Ce qu'il y a dans le dépôt

```
packages/core         lecture du ledger, soumission, traversée des vaults, carte des détenteurs
packages/vault        le cycle de vie XLS-65/66, avec les règles non documentées encodées
packages/settlement   deux rails de règlement — Batch et HTLC — et les moyens de paiement
packages/orderbook    le carnet, l'éligibilité, l'historique des prix
packages/analyst      la notation du risque
apps/cli              la démonstration en terminal
fixtures/             le générateur de monde
probes/               ~350 cas de sonde sur XLS-65/66
probes-marche/        ~70 cas de sonde sur le marché secondaire
FEEDBACK.pdf          le rapport de feedback développeur (3 pages)
PROJET.md             le dossier complet : vocabulaire, normes, architecture
```

---

## Les normes XLS employées

| Norme | Nom | Ce qu'elle apporte au projet |
|---|---|---|
| **XLS-65** | Single Asset Vault | le fonds : dépôts, parts, phases |
| **XLS-66** | Lending Protocol | les prêts, les courtiers, le first-loss capital |
| **XLS-33** | Multi-Purpose Tokens | les parts sont un MPT — c'est ce qui les rend cessibles |
| **XLS-56** | Batch | l'atomicité de l'échange |
| **XLS-70** | Credentials | l'attestation qui identifie un membre |
| **XLS-80** | Permissioned Domains | le club fermé : seuls les porteurs du bon credential entrent |

`OfferCreate` avec un MPT répond `temDISABLED` — le carnet d'ordres natif n'accepte
pas encore les MPT, ce qui est la raison pour laquelle notre carnet est hors chaîne.

---

## Toutes les transactions utilisées, avec une preuve on-chain

Chaque lien pointe une transaction réelle sur le Devnet public.

### XLS-65 — Vault

| Transaction | Rôle dans le projet | Preuve |
|---|---|---|
| `VaultCreate` | créer le vault privé closed-ended | [`080FF8A2…`](https://devnet.xrpl.org/transactions/080FF8A27583F4688B17B2686B9AFD1632A3C6E0C58C6442FCF2487FA396CCEA) |
| `VaultDeposit` | déposer en phase Subscription, recevoir les parts | [`BCEB9818…`](https://devnet.xrpl.org/transactions/BCEB981818DCE10B89B58DDA56DD0B55FD697B51B95E97F2DE652970AFD6B7D7) |
| `VaultWithdraw` | sortir en phase Redemption — et **refusé** en Investment, ce qui fonde le projet | *voir `probes/out/b.json`* |
| `VaultClawback` | saisie par l'émetteur d'un vault IOU — le signal rouge de l'analyste | [`CFE2E142…`](https://devnet.xrpl.org/transactions/CFE2E142336590457D07681F2FEA32BB0C0360A1F16F40FBEB8B9FF69754A9BC) |

### XLS-66 — Prêt

| Transaction | Rôle dans le projet | Preuve |
|---|---|---|
| `LoanBrokerSet` | créer le courtier | [`C80D0BFF…`](https://devnet.xrpl.org/transactions/C80D0BFF4DA03A04D875BAED620F07B8D326A7FF82FC61548C6F210A121C5756) |
| `LoanBrokerCoverDeposit` | déposer le first-loss capital | [`B43FB261…`](https://devnet.xrpl.org/transactions/B43FB261B57A1FBA5A24A71C820F51C81AC4080DD570E14C4A6B39B0A023336C) |
| `LoanBrokerCoverWithdraw` | le retirer — 100 % possible à dette nulle | *voir `probes/out/e.json`* |
| `LoanSet` | accorder un prêt, co-signé emprunteur + courtier | [`C6287B28…`](https://devnet.xrpl.org/transactions/C6287B2890BAD94294B1D59D1D6B38617B4E077557C222C02DB919E5AEF9CA34) |
| `LoanPay` | rembourser une échéance | [`8B15F1F2…`](https://devnet.xrpl.org/transactions/8B15F1F236CBC1D32E8DD2EA5A115A2CAEF781745848B80382F16ABB8C083306) |
| `LoanManage` | constater un impairment ou un défaut | [`9136A3B9…`](https://devnet.xrpl.org/transactions/9136A3B99F87B9526CA57AE12DADA94A253D9F5F9AF294C143C47FE102A5FDD2) |
| `LoanDelete` | purger un prêt soldé | [`A53489EE…`](https://devnet.xrpl.org/transactions/A53489EE42EB36A8C0B937BD407185E040CDC48529405612E5A8FF964CDF1AE2) |

### Identité, jetons et règlement

| Transaction | Rôle dans le projet | Preuve |
|---|---|---|
| `CredentialCreate` | l'émetteur KYC atteste un compte | [`649F3EFD…`](https://devnet.xrpl.org/transactions/649F3EFDA112CBA2DCF8DC25AB2619A35015808DD99CC0025CB8AD27376A9D9F) |
| `CredentialAccept` | le sujet accepte — **sans ça le credential ne vaut rien** | [`0C531E57…`](https://devnet.xrpl.org/transactions/0C531E57A09C819B2EB95B16F68EA84AFB1C87E33A4675E68B08A09D3C1C2EC3) |
| `PermissionedDomainSet` | le domaine qui liste les credentials acceptés | [`F3562B53…`](https://devnet.xrpl.org/transactions/F3562B53C2A8EAE17CE33E8D6BAA063AB75C554AC9241CBBB0D8D8B59D15A4B3) |
| `MPTokenAuthorize` | l'acheteur s'autorise à recevoir les parts | *première jambe du `Batch` ci-dessous* |
| `Payment` (MPT) | le transfert des parts | [`323F9B64…`](https://devnet.xrpl.org/transactions/323F9B643E075085A0F9290637FA24576F79FDD2654FD8AD51363471C5BED760) |
| `Batch` | **l'échange atomique** — parts contre prix | [`B14E9F5A…`](https://devnet.xrpl.org/transactions/B14E9F5A16F7EA3B81D0D00C5C1098DE78250C49141EF0653D84E061945FAC2C) |
| `TrustSet` | la trustline d'un vault en IOU | [`417E22A1…`](https://devnet.xrpl.org/transactions/417E22A1F2C6DA2D7AFDD974B3B91AAB839D0902C8C7974A7104FE1F7883CD86) |
| `AccountSet` | `DefaultRipple` et `AllowTrustLineClawback` de l'émetteur IOU | [`8C7C186F…`](https://devnet.xrpl.org/transactions/8C7C186F3DB94E565DC6059410BFEE590EC9760979F010A804E49943416BE545) |

### Trois transactions qui démontrent un point du rapport

| | Preuve |
|---|---|
| Un `Batch` **`tesSUCCESS` dont aucune jambe n'a appliqué** — 1 seul nœud de métadonnée, la ponction de frais | [`7788D585…`](https://devnet.xrpl.org/transactions/7788D5852DA81935791BC4174A44546FD57C2D26158E0708A90EE2A640E05190) |
| Un `LoanSet` passé avec le **helper du SDK corrigé** en `5.2.0-beta.1`, sans contournement | [`929864F3…`](https://devnet.xrpl.org/transactions/929864F308A9D9A037CCF09219D9867471A1E28393B2CE95FB67429C3B5E5F8D) |
| Un `EscrowFinish` refusé en **`tecNO_AUTH`** : le gate du domaine est revérifié au dénouement | [`9CE88BC1…`](https://devnet.xrpl.org/transactions/9CE88BC1790759574090FB514C4B674B2CEDFECC8EE9E341052B3FCEADCB97FC) |

---

## Le rapport de feedback

**[`FEEDBACK.pdf`](FEEDBACK.pdf)** — 3 pages, six points, chacun détaillé en
*le problème · ce qu'on a vécu · ce qu'on propose*. Les versions longues sont dans
`probes/FRICTIONS.md` et `probes-marche/FRICTIONS.md`, et les résultats bruts de
chaque cas dans `probes/out/`.

Les points, en une ligne chacun :

1. Un `Batch` ne dit pas s'il a produit un effet — et `simulate` ne fonctionne pas dessus
2. Trois drapeaux de `Batch` sur quatre livrent l'actif sans encaisser le prix
3. Aucune primitive de lecture côté XLS-66 — six appels RPC pour reconstituer un vault
4. `LendingProtocolV1_1` est actif et n'est documenté nulle part
5. La co-signature `LoanSet` était invalide — corrigé dans `5.2.0-beta.1`
6. Les MPT dans `Escrow` fonctionnent, et rien ne le dit

---

## Notes

**L'interface est le terminal.** Le CLI couvre le parcours complet, de l'offre au
règlement vérifié. Une interface web en lecture seule, alimentée par
`snapshot.json`, est la suite naturelle.

**Le carnet est hors chaîne, par nécessité.** `OfferCreate` refuse les MPT
(`temDISABLED`), et un escrow exige une `Destination` — impossible de publier une
offre au porteur. Le règlement, lui, est entièrement on-chain.

**Le carnet est unilatéral** : seuls les vendeurs publient. Nous avons vérifié que
l'enveloppe d'un `Batch` peut être portée par l'acheteur, donc un carnet à deux
côtés est constructible — nous ne l'avons pas branché.
