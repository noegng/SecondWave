/**
 * Le vendeur peut-il annuler une offre déjà signée ?
 *
 * Sur le rail classique, l'annulation venait de la séquence : le vendeur bumpait
 * sa `Sequence` à 10 drops et toute enveloppe pré-signée mourait (`tefPAST_SEQ`).
 * En passant aux Tickets (sonde 13), on gagne la durabilité mais on perd ce
 * levier — une offre signée ne meurt plus toute seule.
 *
 * Le remplaçant théorique : CONSOMMER le ticket. N'importe quelle transaction
 * portée par ce `TicketSequence` le détruit, et tout ce qui était signé dessus
 * devient insoumettable. Le moins cher est un `AccountSet` sans aucun champ.
 *
 *   C1  une offre signée sur ticket, ticket consommé, puis soumise  → doit ÉCHOUER
 *   C2  le ticket a-t-il bien disparu du ledger ?
 *   C3  combien coûte une annulation ?
 *   C4  annuler deux fois — le second geste échoue-t-il proprement ?
 *   C5  l'annulation par le vendeur tue-t-elle aussi la signature de l'acheteur ?
 *
 * C1 est le test du bouton « Annuler ». S'il échoue, le bouton est un mensonge.
 */
import { BatchFlags, signMultiBatch, encodeForSigning, kpSign, sendRaw, TF_INNER } from './_lib.mjs'
import { connect, fundAccount, submit, sequence, sleep } from '@secondwave/core'

const c = await connect()
const resultats = []
const note = (id, quoi, code, lecture = '') => {
  resultats.push({ id, quoi, code, lecture })
  console.log(`  [${id}] ${String(code).padEnd(18)} ${quoi}`)
  if (lecture) console.log(`        ↳ ${lecture}`)
}

console.log('Financement…')
const A = await fundAccount()   // vendeur
const B = await fundAccount()   // acheteur
console.log(`  A ${A.classicAddress}\n  B ${B.classicAddress}\n`)
await sleep(4000)

async function tickets(w, n) {
  const r = await submit(c, { TransactionType: 'TicketCreate', Account: w.classicAddress, TicketCount: n }, w)
  if (!r.ok) throw new Error(`TicketCreate: ${r.result}`)
  const o = await c.request({ command: 'account_objects', account: w.classicAddress, type: 'ticket', ledger_index: 'validated' })
  return o.result.account_objects.map(x => x.TicketSequence).sort((a, b) => a - b)
}
const tA = await tickets(A, 4)
const tB = await tickets(B, 4)
console.log(`tickets A : ${tA.join(', ')}\ntickets B : ${tB.join(', ')}\n`)

/** Le Batch de swap, entièrement porté par des tickets, sans expiration. */
function offreSignee({ enveloppe, jambeA, jambeB }) {
  const jambe = t => ({ RawTransaction: { ...t, Fee: '0', SigningPubKey: '', Flags: TF_INNER } })
  const batch = {
    TransactionType: 'Batch', Account: A.classicAddress, Flags: BatchFlags.tfAllOrNothing,
    Sequence: 0, TicketSequence: enveloppe,
    Fee: '150',
    RawTransactions: [
      jambe({ TransactionType: 'Payment', Account: A.classicAddress, Destination: B.classicAddress,
              Amount: '1000000', Sequence: 0, TicketSequence: jambeA }),
      jambe({ TransactionType: 'Payment', Account: B.classicAddress, Destination: A.classicAddress,
              Amount: '2000000', Sequence: 0, TicketSequence: jambeB }),
    ],
  }
  signMultiBatch(B, batch)
  batch.SigningPubKey = A.publicKey
  batch.TxnSignature = kpSign(encodeForSigning(batch), A.privateKey)
  return batch
}

/** Le geste d'annulation : une transaction vide portée par le ticket à brûler. */
const annuler = (wallet, ticket) => submit(c, {
  TransactionType: 'AccountSet', Account: wallet.classicAddress,
  Sequence: 0, TicketSequence: ticket,
}, wallet)

const ticketsDe = async (w) => {
  const o = await c.request({ command: 'account_objects', account: w.classicAddress, type: 'ticket', ledger_index: 'validated' })
  return o.result.account_objects.map(x => x.TicketSequence).sort((a, b) => a - b)
}

// ─── C1 · le test du bouton ────────────────────────────────────────────────
console.log('══ C1 · offre signée, ticket consommé, puis soumise ══')
const offre = offreSignee({ enveloppe: tA[0], jambeA: tA[1], jambeB: tB[0] })
console.log('   offre signée par A et B, mise de côté.')

const geste = await annuler(A, tA[0])
console.log(`   A clique « annuler » → AccountSet sur le ticket de l'enveloppe : ${geste.result}`)

const rejet = await sendRaw(c, offre)
note('C1', 'soumission d\'une offre annulée', rejet.engine ?? rejet.result,
  rejet.engine === 'tesSUCCESS'
    ? '🔴 L\'ANNULATION NE MARCHE PAS — l\'offre est passée quand même'
    : 'l\'offre est bien morte : le bouton « Annuler » est honnête')

// ─── C2 · le ticket a-t-il disparu ? ───────────────────────────────────────
const restants = await ticketsDe(A)
note('C2', 'tickets restants chez A', restants.join(', '),
  restants.includes(tA[0]) ? '🔴 le ticket est toujours là' : `${tA[0]} a bien été détruit`)

// ─── C3 · le coût ──────────────────────────────────────────────────────────
const fee = geste.raw?.result?.tx_json?.Fee ?? geste.raw?.result?.Fee ?? '?'
note('C3', 'coût d\'une annulation', `${fee} drops`, `soit ${(Number(fee) / 1e6).toFixed(6)} XRP`)

// ─── C4 · annuler deux fois ────────────────────────────────────────────────
const encore = await annuler(A, tA[0])
note('C4', 'seconde annulation du même ticket', encore.result,
  encore.ok ? '🔴 inattendu' : 'échec propre — l\'interface peut le traduire en « déjà annulée »')

// ─── C5 · le vendeur peut-il tuer une offre que l'acheteur a signée ? ──────
console.log('\n══ C5 · l\'acheteur a signé, le vendeur annule ══')
const offre2 = offreSignee({ enveloppe: tA[2], jambeA: tA[3], jambeB: tB[1] })
console.log('   B a signé ses BatchSigners. A n\'a pas encore confirmé… et annule.')
const geste2 = await annuler(A, tA[2])
const rejet2 = await sendRaw(c, offre2)
note('C5', `annulation après signature de l'acheteur (${geste2.result})`, rejet2.engine ?? rejet2.result,
  rejet2.engine === 'tesSUCCESS'
    ? '🔴 le vendeur ne peut pas se dédire'
    : 'le vendeur garde la main jusqu\'au bout')

// ─── Synthèse ──────────────────────────────────────────────────────────────
console.log('\n╔═══════════════════════════════════════════════════════════════════╗')
console.log('║  SYNTHÈSE — le bouton « Annuler »                                 ║')
console.log('╚═══════════════════════════════════════════════════════════════════╝')
for (const r of resultats) console.log(`  ${r.id.padEnd(4)} ${String(r.code).padEnd(20)} ${r.quoi}`)
const c1 = resultats.find(r => r.id === 'C1')
console.log(`\n  VERDICT : ${c1 && c1.code !== 'tesSUCCESS'
  ? 'consommer le ticket annule bien une offre signée — le bouton est implémentable.'
  : '🔴 le mécanisme ne tient pas, ne pas construire le bouton dessus.'}`)
await c.disconnect()
