# Brief hackathon — XRPL Lending Protocol

**12–13 septembre 2026** · IIM, Campus du Parc, 47 Bd de Pesaro, Nanterre · DeVinci Blockchain × Ripple
WIFI `ZQ93FF77` / `Spmdj` · HOOK INVITE CODE `BFT-PARIS-26`

---

# 🔴 Deux points critiques

## 1. La version de xrpl.js — ✅ réglé
Le Notion a été mis à jour le 12/09 : il exige désormais **`xrpl.js@5.2.0-beta.1`**.
✅ Installée et épinglée en exact (pas de caret — `^5.2.0-beta.0` résout vers la 5.2.0 stable).
✅ Les champs V1_1 sont dedans → aucune definition custom nécessaire.
✅ **Le fix de co-signature `LoanSet` y est** — vérifié sur la chaîne.

## 2. Ne jamais mélanger les tracks
| | Track 1 | **Track 2 ← le nôtre** |
|---|---|---|
| Vault | Open-ended | **Closed-ended** |
| Protocole | Lending V1 | **Lending V1.1** |
| Réseau | Custom Hackathon Devnet | **Public XRPL Devnet** |
| Faucet | `lending-hackathon-faucet.dev.ripplex.io/accounts` | **`faucet.devnet.rippletest.net/accounts`** |
| RPC | `lending-hackathon.dev.ripplex.io:51234` | **`s.devnet.rippletest.net:51234`** |
| WSS | `wss://lending-hackathon.dev.ripplex.io:51233` | **`wss://s.devnet.rippletest.net:51233`** |
| Explorer | `custom.xrpl.org/lending-hackathon…` | **`devnet.xrpl.org`** |
| Lib | xrpl.js stable | **`xrpl.js@5.2.0-beta.1`** |

✅ **Notre réseau est le bon, et la version de lib aussi** (vérifié : rippled 3.4.0-rc5, network_id 2).

---

# ⚖️ Jugement — le feedback vaut 40 %

| Critère | Poids |
|---|---|
| **Qualité du feedback développeur** | **40 %** |
| Exécution technique sur XRPL | 30 % |
| Créativité et cas d'usage | 20 % |
| Présentation et démo live | 10 % |

> 💰 **Bonus explicite :** *« A documentation correction, reusable code sample, reference implementation or pull request is a bonus contribution. »*
> → Le fix `LoanSet` a été **intégré par Ripple dans la beta.1** — plus de PR à ouvrir, mais le diagnostic reste notre meilleur point de feedback.

**Prix :** 10 000 $ — 5 000 $ pour les 4 premières équipes, 5 000 $ de voyage Swell partagé entre les 2 meilleures.

---

# ✅ Minimum bar Track 2

- [ ] Vault closed-ended avec dates compressées à la durée de l'événement
- [ ] Dépôt pendant **Subscription**
- [ ] Pendant **Investment** : originer et financer un prêt **dont la dernière échéance tombe avant Redemption**
- [ ] Pendant **Redemption** : retirer le capital **plus le rendement accumulé**
- [ ] **Démontrer des `VaultDeposit`, `VaultWithdraw` et `LoanSet` refusés à la mauvaise phase**
- [ ] Envelopper le cycle dans un cas d'usage crédible

👉 **Notre marché secondaire est AU-DESSUS de ce socle. Le socle doit exister d'abord.**

**Vanilla ou Loaded :** on est **Loaded** (Permissioned Domains + Credentials).
⚠️ *« Loaded is not automatically better »* — ne l'ajouter que si ça crée un vrai cas d'usage ou un feedback utile. Chez nous oui : le gate conditionne le marché.

---

# 📦 Livrables — dimanche 13/09, 13:00 CEST

- [ ] Dépôt GitHub **public**
- [ ] **README** : ce que fait le projet, installation, **track, environnement, version de lib, et TOUTES les transactions XLS-65/66 utilisées**
- [ ] **Liens vers des transactions on-chain vérifiées**
- [ ] **Deck de 10 slides max**
- [ ] **Rapport de feedback manuel à la racine du dépôt — 3 pages max**
- [ ] Formulaire DevEx rempli avec les membres et les handles GitHub

## Format du rapport de feedback
En-tête obligatoire : **track, flavour, environnement, version de lib**.
Par problème : **catégorie · titre · description · étapes de repro ou lien tx/code · sévérité · lib et version**.
Catégories : `client libraries` · `UX` · `missing primitive` · `documentation/tutorials` · `other`.

> 📌 Source : `datablockchain/4 - XRPL/XRP Ledger (L1)/Hackathons/⚠️ Frictions & contournements — le projet.md` — **34 points déjà documentés**. Il faut les **condenser en 3 pages** et les reformater.

---

# 🎤 Présentation

**4 minutes de démo live + 2 minutes de Q&A.**
Doit couvrir : le cas d'usage · le flux on-chain · **les trois frictions les plus importantes et les améliorations proposées**.

⚠️ *(Ma note précédente parlait de 60 s — c'est faux, c'est 4 minutes.)*

---

# ⚠️ Sécurité — à faire AVANT toute présentation
> *« Potential protocol security issues must be reported privately to a mentor before any presentation. »*

**Nos découvertes qui pourraient qualifier :**
- le broker peut retirer **100 %** du first-loss capital quand `DebtTotal = 0`
- l'**émetteur de l'actif** peut saisir la position d'un déposant (`VaultClawback` sur vault IOU)
- le Batch renvoie `tesSUCCESS` alors qu'aucune jambe n'a appliqué

👉 **En parler à Maxime ou Shota avant le pitch.**

---

# 🗓️ Programme

**Samedi 12** — 09:00 portes · 09:45 intro · 10:05 workshop XRPL (Maxime) · 10:25 workshop Lending (Shota) · 10:45 challenge et jugement · 11:30 **début du hacking** · 13:00 déjeuner · 19:00 dîner · **20:00 stand-up d'une minute** · 21:00 fermeture, suite en remote sur Discord
**Dimanche 13** — 08:30 portes · 11:00 coaching pitch · **12:30 code freeze** · **13:00 remise** · 14:00 pitches · 16:00 remise des prix

---

# 📞 Contacts
**Ripple** — Maxime (workshop XRPL, challenge, jury) · Shota (workshop Lending, jury)
**DVB** — Romain, lead `t.me/romthpt` · Adrian, manager `t.me/aiden_7788`

# 🔗 Ressources utiles non exploitées
Slides de l'événement · **Reference lending application** · SAV explainer videos · **XRPL Skills et MCP** · Context7 XRPL docs · XRPL CLI · xrpl-connect wallet adapter

---

# ❓ Questions du jury auxquelles on a déjà les réponses (Track 2)
- Le modèle en trois phases était-il intuitif ? → **oui, mais non documenté** (V1_1 n'a aucune spec publiée)
- `VaultKind`, `SubscriptionDate`, `RedemptionDate` étaient-ils explicites ? → **absents du SDK publié**
- Les messages d'erreur de phase étaient-ils lisibles ? → `tecTOO_SOON` / `tecEXPIRED`, **opaques**
- La contrainte « dernière échéance avant Redemption » était-elle claire ? → **non, découverte par essai-erreur**
- La comptabilité cash-basis se comportait-elle comme attendu ? → **oui, vérifié** : `AssetsTotal` ne bouge qu'à l'encaissement
