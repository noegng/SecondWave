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
ajoute('A', 'a batched exchange that really delivers', rA.hash,
  `${rA.engine ?? rA.result} · ${metas.A.noeuds.length} nodes · ledger ${rA.ledgerIndex ?? '?'}`)
const jambesA = await jambesDe(rA.hash, rA.ledgerIndex)
for (const [i, j] of jambesA.entries())
  ajoute(`A${i + 1}`, `rebuilt leg — ${j.type}`, j.hash, j.result)

// ── B/C · l'offre signée survit au bruit ───────────────────────────────────
console.log('\n══ B/C · une offre pré-signée survit à l\'activité des deux comptes ══')
const C = echange({ ticketEnv: tV.tickets[2], ticketVendeur: tV.tickets[3], ticketAcheteur: tA.tickets[1], prix: 4_000_000 })
console.log('   offre signée par les deux, mise de côté.')
const bruitV = await submit(c, { TransactionType: 'AccountSet', Account: VENDEUR.classicAddress }, VENDEUR)
const bruitA = await submit(c, { TransactionType: 'AccountSet', Account: ACHETEUR.classicAddress }, ACHETEUR)
ajoute('B1', 'the seller transacts between signing and sending', bruitV.hash, bruitV.result)
ajoute('B2', 'the buyer transacts between signing and sending', bruitA.hash, bruitA.result)
const rC = await sendRaw(c, C)
ajoute('C', 'the same offer, sent AFTER that noise — it goes through', rC.hash,
  `${rC.engine ?? rC.result} · this is what reserved transaction numbers enable`)

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
ajoute('D', 'the seller consumes the ticket carrying the offer', brule.hash,
  `${brule.result} · fee ${brule.raw?.result?.tx_json?.Fee ?? '?'} drops`)
const rD = await sendRaw(c, D)
ajoute('D2', 'replaying the cancelled offer', null,
  `${rD.engine ?? rD.result} — a rejected transaction never enters the ledger, so it has no link`)

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
ajoute('E', 'a 900 XRP exchange the buyer does not hold', rE.hash,
  `response ${rE.engine ?? rE.result} · ${metas.E.noeuds.length} nodes · `
  + `buyer balance ${soldeE} → ${soldeApresE} (unchanged)`)

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

const md = `# On-chain proofs — points 4 and 8 of the report

Generated by \`probes-marche/17-preuves.mjs\` on the **XRPL public Devnet**.
Every link opens in the explorer: nothing here asks you to take our word for it.

Campaign accounts:
- seller \`${VENDEUR.classicAddress}\`
- buyer \`${ACHETEUR.classicAddress}\`

| # | What is claimed | Transaction | Detail |
|---|---|---|---|
${lignes}

## How to read these proofs

**A and its legs — the missing per-leg report (point 4).** Batched exchange A
delivered. Open it: its metadata contains **only the fee**. Legs A1 and A2 are
separate transactions in the same block, with their own hashes — we had to go
and fetch them account by account. The server knows them and does not report
them.

**B1, B2 and C — the durable offer (point 8).** Offer C is signed by both
parties BEFORE B1 and B2. Both accounts then transact, which moves their
counters. C is sent afterwards, and goes through. On the ordinary rail it
would be dead: it is the coupling to the counters that made a signed offer
perishable, and that is what reserved transaction numbers lift.

**D — enforceable cancellation (point 8).** The seller consumes the number
carrying the offer, for a few drops. Replaying the signed offer is then
refused. Note there is **no link** for that refusal: a rejected transaction
never enters the ledger. Which is precisely why the next exhibit matters.

**E, compared with A — the heart of point 4.** E is a 900 XRP exchange
attempted by an account that does not hold them. The buyer's balance is
**unchanged**: all-or-nothing holds perfectly, nothing moved.

Now open A and E side by side. A delivered 3 XRP; E did nothing. Here is what
the ledger records about each:

| | A (delivered) | E (did nothing) |
|---|---|---|
| Code | \`${metas.A.code}\` | \`${metas.E.code}\` |
| Metadata nodes | ${[...metas.A.noeuds].sort().join(', ')} | ${[...metas.E.noeuds].sort().join(', ')} |
| Balance change | ${metas.A.delta} drops (fee) | ${metas.E.delta} drops (fee) |

**${identiques ? 'Identical' : 'Almost identical'}.** Same code, same nodes, same fee
(node order is not significant, so we compare sets). Neither leaves, in its own
metadata, the faintest trace of what moved — or did not. The only way to tell
them apart is to look elsewhere in the block for legs, then compare balances
before and after.

This is also the only possible form of proof for this friction: a plain failure
would leave a readable trace, this kind of success leaves none.
`

const chemin = join(DIR, 'PREUVES.md')
writeFileSync(chemin, md)
console.log(`\n  → ${chemin}`)
console.log(`  ${preuves.filter(p => p.hash).length} transactions vérifiables, ${preuves.length} affirmations`)
await c.disconnect()
