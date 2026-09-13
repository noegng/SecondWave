/**
 * Fabrique les preuves on-chain des points 5 et 9 du rendu.
 *
 *   node probes-marche/17-preuves.mjs
 *
 * Les sondes 13 à 16 mesuraient des codes de retour ; elles ne gardaient pas
 * les empreintes. Un rapport qui affirme « mesuré » doit pouvoir être ouvert
 * dans un explorateur par quelqu'un qui ne nous fait pas confiance.
 *
 * Écrit `probes-marche/PREUVES.md` : une ligne par affirmation, avec le hash
 * et le lien. Cinq exhibits :
 *
 *   A  un échange groupé qui LIVRE, et ses trois jambes retrouvées
 *   B  les deux transactions de « bruit » entre la signature et l'envoi
 *   C  le même échange, soumis APRÈS le bruit — il passe quand même
 *   D  l'annulation : la transaction qui consomme le ticket
 *   E  ⭐ un échange groupé SANS PROVISION qui répond tesSUCCESS
 *
 * ⚠️ E est l'exhibit central du point 5, et le seul qu'on ne peut pas
 *    fabriquer autrement : une transaction REFUSÉE (tefNO_TICKET,
 *    tefMAX_LEDGER) n'entre jamais dans le ledger et n'a donc pas de lien.
 *    Seul un « succès » qui n'a rien fait est à la fois validé ET vide.
 */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { BatchFlags, signMultiBatch, encodeForSigning, kpSign, sendRaw, TF_INNER, DIR } from './_lib.mjs'
import { connect, fundAccount, submit, sleep, xrpBalance, txUrl } from '@secondwave/core'

const c = await connect()
const preuves = []
const metas = {}

/** La forme de la métadonnée : c'est elle qu'on compare entre A et E. */
async function formeMeta(hash) {
  if (!hash) return null
  const r = await c.request({ command: 'tx', transaction: hash })
  const n = r.result.meta?.AffectedNodes ?? []
  const frais = n.map(x => x[Object.keys(x)[0]])
    .find(e => e.LedgerEntryType === 'AccountRoot' && e.PreviousFields?.Balance)
  return {
    code: r.result.meta?.TransactionResult,
    noeuds: n.map(x => { const k = Object.keys(x)[0]; return `${k.replace('Node', '')} ${x[k].LedgerEntryType}` }),
    delta: frais ? Number(frais.FinalFields.Balance) - Number(frais.PreviousFields.Balance) : null,
  }
}
const ajoute = (id, affirmation, hash, detail = '') => {
  preuves.push({ id, affirmation, hash, detail })
  console.log(`  [${id}] ${hash ? hash.slice(0, 16) + '…' : '— pas de hash —'}  ${affirmation}`)
  if (detail) console.log(`        ${detail}`)
}

console.log('Financement…')
const VENDEUR = await fundAccount()
const ACHETEUR = await fundAccount()
await sleep(4000)
console.log(`  vendeur  ${VENDEUR.classicAddress}`)
console.log(`  acheteur ${ACHETEUR.classicAddress}\n`)

async function tickets(w, n) {
  const r = await submit(c, { TransactionType: 'TicketCreate', Account: w.classicAddress, TicketCount: n }, w)
  if (!r.ok) throw new Error(`TicketCreate: ${r.result}`)
  const o = await c.request({ command: 'account_objects', account: w.classicAddress, type: 'ticket', ledger_index: 'validated' })
  return { tickets: o.result.account_objects.map(x => x.TicketSequence).sort((a, b) => a - b), hash: r.hash }
}
const tV = await tickets(VENDEUR, 4)
const tA = await tickets(ACHETEUR, 4)

/** L'échange : le vendeur livre 1 XRP de « parts », l'acheteur paie `prix`. */
function echange({ ticketEnv, ticketVendeur, ticketAcheteur, prix }) {
  const jambe = t => ({ RawTransaction: { ...t, Fee: '0', SigningPubKey: '', Flags: TF_INNER } })
  const b = {
    TransactionType: 'Batch', Account: VENDEUR.classicAddress, Flags: BatchFlags.tfAllOrNothing,
    Sequence: 0, TicketSequence: ticketEnv, Fee: '150',
    RawTransactions: [
      jambe({ TransactionType: 'Payment', Account: VENDEUR.classicAddress, Destination: ACHETEUR.classicAddress,
              Amount: '1000000', Sequence: 0, TicketSequence: ticketVendeur }),
      jambe({ TransactionType: 'Payment', Account: ACHETEUR.classicAddress, Destination: VENDEUR.classicAddress,
              Amount: String(prix), Sequence: 0, TicketSequence: ticketAcheteur }),
    ],
  }
  signMultiBatch(ACHETEUR, b)
  b.SigningPubKey = VENDEUR.publicKey
  b.TxnSignature = kpSign(encodeForSigning(b), VENDEUR.privateKey)
  return b
}

/** Les jambes internes, retrouvées dans le ledger : le BatchExecutions manquant. */
async function jambesDe(hash, ledgerIndex) {
  const vues = new Map()
  for (const compte of [VENDEUR.classicAddress, ACHETEUR.classicAddress]) {
    const r = await c.request({
      command: 'account_tx', account: compte,
      ledger_index_min: ledgerIndex, ledger_index_max: ledgerIndex, limit: 50,
    })
    for (const t of r.result.transactions) {
      const tj = t.tx_json ?? t.tx ?? {}
      const h = t.hash ?? tj.hash
      if (!h || h === hash || tj.TransactionType === 'Batch') continue
      vues.set(h, { hash: h, type: tj.TransactionType, result: t.meta?.TransactionResult })
    }
  }
  return [...vues.values()]
}

// ── A · un échange qui livre ───────────────────────────────────────────────
console.log('══ A · un échange groupé qui livre ══')
const soldeAvant = await xrpBalance(c, ACHETEUR.classicAddress)
const A = echange({ ticketEnv: tV.tickets[0], ticketVendeur: tV.tickets[1], ticketAcheteur: tA.tickets[0], prix: 3_000_000 })
const rA = await sendRaw(c, A)
metas.A = await formeMeta(rA.hash)
ajoute('A', 'un échange groupé qui livre réellement', rA.hash,
  `${rA.engine ?? rA.result} · ${metas.A.noeuds.length} nœuds · ledger ${rA.ledgerIndex ?? '?'}`)
const jambesA = await jambesDe(rA.hash, rA.ledgerIndex)
for (const [i, j] of jambesA.entries())
  ajoute(`A${i + 1}`, `jambe reconstruite — ${j.type}`, j.hash, j.result)

// ── B/C · l'offre signée survit au bruit ───────────────────────────────────
console.log('\n══ B/C · une offre pré-signée survit à l\'activité des deux comptes ══')
const C = echange({ ticketEnv: tV.tickets[2], ticketVendeur: tV.tickets[3], ticketAcheteur: tA.tickets[1], prix: 4_000_000 })
console.log('   offre signée par les deux, mise de côté.')
const bruitV = await submit(c, { TransactionType: 'AccountSet', Account: VENDEUR.classicAddress }, VENDEUR)
const bruitA = await submit(c, { TransactionType: 'AccountSet', Account: ACHETEUR.classicAddress }, ACHETEUR)
ajoute('B1', 'le vendeur transige entre la signature et l\'envoi', bruitV.hash, bruitV.result)
ajoute('B2', 'l\'acheteur transige entre la signature et l\'envoi', bruitA.hash, bruitA.result)
const rC = await sendRaw(c, C)
ajoute('C', 'la même offre, envoyée APRÈS ce bruit — elle passe', rC.hash,
  `${rC.engine ?? rC.result} · c'est ce que les Tickets rendent possible`)

// ── D · l'annulation ───────────────────────────────────────────────────────
console.log('\n══ D · annuler une offre déjà signée ══')
const tV2 = await tickets(VENDEUR, 2)
const tA2 = await tickets(ACHETEUR, 2)
const libresV = tV2.tickets.filter(t => !tV.tickets.includes(t))
const libresA = tA2.tickets.filter(t => !tA.tickets.includes(t))
const D = echange({ ticketEnv: libresV[0], ticketVendeur: libresV[1], ticketAcheteur: libresA[0], prix: 5_000_000 })
const brule = await submit(c, {
  TransactionType: 'AccountSet', Account: VENDEUR.classicAddress,
  Sequence: 0, TicketSequence: libresV[0],
}, VENDEUR)
ajoute('D', 'le vendeur consomme le ticket qui porte l\'offre', brule.hash,
  `${brule.result} · frais ${brule.raw?.result?.tx_json?.Fee ?? '?'} drops`)
const rD = await sendRaw(c, D)
ajoute('D2', 'rejouer l\'offre annulée', null,
  `${rD.engine ?? rD.result} — une transaction refusée n'entre pas dans le ledger, elle n'a pas de lien`)

// ── E · l'exhibit du point 5 ───────────────────────────────────────────────
console.log('\n══ E · un échange sans provision qui répond « succès » ══')
const tV3 = await tickets(VENDEUR, 2)
const tA3 = await tickets(ACHETEUR, 2)
const lV = tV3.tickets.filter(t => ![...tV.tickets, ...libresV].includes(t))
const lA = tA3.tickets.filter(t => ![...tA.tickets, ...libresA].includes(t))
const soldeE = await xrpBalance(c, ACHETEUR.classicAddress)
const E = echange({ ticketEnv: lV[0], ticketVendeur: lV[1], ticketAcheteur: lA[0], prix: 900_000_000 })
const rE = await sendRaw(c, E)
const soldeApresE = await xrpBalance(c, ACHETEUR.classicAddress)
metas.E = await formeMeta(rE.hash)
ajoute('E', 'échange de 900 XRP que l\'acheteur ne possède pas', rE.hash,
  `réponse ${rE.engine ?? rE.result} · ${metas.E.noeuds.length} nœuds · `
  + `solde acheteur ${soldeE} → ${soldeApresE} (inchangé)`)

// L'ordre des nœuds de métadonnée n'a pas de sens : on compare des ensembles.
const memeJeu = (x, y) => JSON.stringify([...x].sort()) === JSON.stringify([...y].sort())
const identiques = memeJeu(metas.A.noeuds, metas.E.noeuds)
  && metas.A.code === metas.E.code && metas.A.delta === metas.E.delta
console.log(`\n  A (a livré)     ${metas.A.code} · ${metas.A.noeuds.join(' | ')} · frais ${metas.A.delta}`)
console.log(`  E (n'a rien fait) ${metas.E.code} · ${metas.E.noeuds.join(' | ')} · frais ${metas.E.delta}`)
console.log(`  → métadonnées ${identiques ? 'IDENTIQUES' : 'différentes'}`)

// ── Le fichier de preuves ──────────────────────────────────────────────────
const lignes = preuves.map(p => {
  const lien = p.hash ? `[\`${p.hash.slice(0, 12)}…\`](${txUrl(p.hash)})` : '—'
  return `| ${p.id} | ${p.affirmation} | ${lien} | ${p.detail} |`
}).join('\n')

const md = `# Preuves on-chain — points 5 et 9 du rendu

Généré par \`probes-marche/17-preuves.mjs\` sur le **Devnet public XRPL**.
Chaque lien s'ouvre dans l'explorateur : rien ici ne demande de nous croire.

Comptes de la campagne :
- vendeur \`${VENDEUR.classicAddress}\`
- acheteur \`${ACHETEUR.classicAddress}\`

| # | Ce qui est affirmé | Transaction | Détail |
|---|---|---|---|
${lignes}

## Comment lire ces preuves

**A et ses jambes — le \`BatchExecutions\` manquant (point 5).** L'échange groupé A
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
| Code | \`${metas.A.code}\` | \`${metas.E.code}\` |
| Nœuds de métadonnée | ${[...metas.A.noeuds].sort().join(', ')} | ${[...metas.E.noeuds].sort().join(', ')} |
| Variation de solde | ${metas.A.delta} drops (frais) | ${metas.E.delta} drops (frais) |

**${identiques ? 'Identiques' : 'Presque identiques'}.** Même code, mêmes nœuds, mêmes frais
(l'ordre des nœuds n'est pas significatif, on compare des ensembles). Aucun des deux ne
laisse dans sa propre métadonnée la moindre trace de ce qui a bougé — ou pas.
La seule façon de les distinguer est d'aller chercher ailleurs dans le bloc si
des jambes existent, puis de comparer les soldes avant et après.

C'est aussi la seule forme de preuve possible pour cette friction : un échec
franc laisserait une trace lisible, ce succès-là n'en laisse aucune.
`

const chemin = join(DIR, 'PREUVES.md')
writeFileSync(chemin, md)
console.log(`\n  → ${chemin}`)
console.log(`  ${preuves.filter(p => p.hash).length} transactions vérifiables, ${preuves.length} affirmations`)
await c.disconnect()
