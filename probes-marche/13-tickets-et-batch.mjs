/**
 * Une offre signée est-elle périssable ?
 *
 * Le rail Batch fige les `Sequence` des DEUX comptes dans ce que chacun signe.
 * Conséquence : le vendeur ne peut pas pré-signer, parce que la moindre autre
 * transaction de l'un des deux invalide l'enveloppe. C'est ce qui sépare un
 * carnet d'ordres d'une poignée de main synchrone.
 *
 * Le protocole a un outil pour ça : les Tickets (une séquence réservée
 * d'avance). XLS-65 et XLS-66 reconnaissent `TicketSequence` à la place de
 * `Sequence`. Et `signMultiBatch` du SDK lit déjà `TicketSequence` sur
 * l'enveloppe (`getBatchSeqValue`, xrpl/dist/npm/Wallet/batchSigner.js).
 *
 * Reste à savoir ce que rippled en fait. Sept mesures :
 *
 *   T0  témoin           Batch classique, deux jambes                → doit passer
 *   T1  jambe interne    la jambe du vendeur sur un Ticket
 *   T2  enveloppe        l'enveloppe du vendeur sur un Ticket
 *   T3  tout             enveloppe + les deux jambes sur Tickets
 *   T4  DÉCISIF          pré-signé sur Tickets, PUIS les deux comptes
 *                        transigent ailleurs, PUIS on soumet
 *   T5  fenêtre longue   LastLedgerSequence = li + 200 (~10 min)
 *   T6  fenêtre absente  pas de LastLedgerSequence du tout
 *
 * T4 est le seul qui compte : s'il passe, une offre signée survit à la vie des
 * comptes, et le carnet devient possible. Sinon, c'est une demande à formuler.
 *
 * Aucun vault ici : deux Payments XRP croisés suffisent à poser la question.
 */
import {
  BatchFlags, signMultiBatch, encodeForSigning, kpSign, encode,
  batchEnvelope, leg, sendRaw, TF_INNER,
} from './_lib.mjs'
import { connect, fundAccount, submit, sequence, sleep, xrpBalance } from '@secondwave/core'

const c = await connect()
const resultats = []
const note = (id, quoi, r, lecture = '') => {
  const code = r.engine ?? r.result ?? '?'
  resultats.push({ id, quoi, code, lecture })
  console.log(`  [${id}] ${code.padEnd(18)} ${quoi}${r.message ? `\n        ${r.message}` : ''}`)
}

console.log('Financement de deux comptes…')
const A = await fundAccount()   // le vendeur : il porte l'enveloppe
const B = await fundAccount()   // l'acheteur : il porte les BatchSigners
console.log(`  A (vendeur)  ${A.classicAddress}`)
console.log(`  B (acheteur) ${B.classicAddress}\n`)
await sleep(4000)

// ─── Tickets ────────────────────────────────────────────────────────────────
/** Crée N tickets et renvoie leurs numéros, lus dans le ledger (pas devinés). */
async function tickets(wallet, count) {
  const r = await submit(c, {
    TransactionType: 'TicketCreate', Account: wallet.classicAddress, TicketCount: count,
  }, wallet)
  if (!r.ok) throw new Error(`TicketCreate ${wallet.classicAddress}: ${r.result} ${r.message ?? ''}`)
  const objs = await c.request({
    command: 'account_objects', account: wallet.classicAddress, type: 'ticket', ledger_index: 'validated',
  })
  return objs.result.account_objects.map(o => o.TicketSequence).sort((x, y) => x - y)
}

console.log('Création de 6 tickets par compte…')
const tA = await tickets(A, 6)
const tB = await tickets(B, 6)
console.log(`  A : ${tA.join(', ')}`)
console.log(`  B : ${tB.join(', ')}\n`)

// ─── Construction d'un swap ────────────────────────────────────────────────
const PARTS = '1000000'   // « les parts » : 1 XRP de A vers B
const PRIX  = '2000000'   // « le prix »   : 2 XRP de B vers A

/** Une jambe séquencée soit par Sequence, soit par TicketSequence. */
const jambe = (tx, { seq = null, ticket = null }) => ({
  ...tx,
  ...(ticket != null ? { Sequence: 0, TicketSequence: ticket } : { Sequence: seq }),
})

const jambeParts = o => jambe({
  TransactionType: 'Payment', Account: A.classicAddress,
  Destination: B.classicAddress, Amount: PARTS,
}, o)

const jambePrix = o => jambe({
  TransactionType: 'Payment', Account: B.classicAddress,
  Destination: A.classicAddress, Amount: PRIX,
}, o)

/**
 * Construit l'enveloppe et la fait signer par les deux.
 * `enveloppeTicket` : l'enveloppe de A est portée par un ticket au lieu d'une séquence.
 */
async function swap({ jambes, enveloppeTicket = null, enveloppeSeq = null, lls = 'court' }) {
  const li = (await c.request({ command: 'ledger', ledger_index: 'validated' })).result.ledger_index
  const batch = {
    TransactionType: 'Batch', Account: A.classicAddress, Flags: BatchFlags.tfAllOrNothing,
    RawTransactions: jambes.map(t => ({ RawTransaction: { ...t, Fee: '0', SigningPubKey: '', Flags: TF_INNER } })),
    Fee: String(50 * (jambes.length + 1)),
    ...(enveloppeTicket != null
      ? { Sequence: 0, TicketSequence: enveloppeTicket }
      : { Sequence: enveloppeSeq ?? await sequence(c, A.classicAddress) }),
    ...(lls === 'aucun' ? {} : { LastLedgerSequence: li + (lls === 'long' ? 200 : 25) }),
  }
  signMultiBatch(B, batch)
  batch.SigningPubKey = A.publicKey
  batch.TxnSignature = kpSign(encodeForSigning(batch), A.privateKey)
  return batch
}

/** Emballe une construction qui peut lever (validation SDK) en un résultat lisible. */
async function tente(fn) {
  try { return await fn() }
  catch (e) { return { engine: 'SDK-REJET', message: e.message } }
}

// ─── T0 · témoin ────────────────────────────────────────────────────────────
console.log('══ T0 · témoin : Batch classique ══')
{
  const r = await tente(async () => {
    const sA = await sequence(c, A.classicAddress), sB = await sequence(c, B.classicAddress)
    const b = await swap({
      enveloppeSeq: sA,
      jambes: [jambeParts({ seq: sA + 1 }), jambePrix({ seq: sB })],
    })
    return sendRaw(c, b)
  })
  note('T0', 'Sequence partout — le rail actuel', r, 'témoin : si ça échoue, tout le reste est ininterprétable')
}

// ─── T1 · jambe interne sur ticket ─────────────────────────────────────────
console.log('\n══ T1 · la jambe interne du vendeur sur un Ticket ══')
{
  const r = await tente(async () => {
    const sA = await sequence(c, A.classicAddress), sB = await sequence(c, B.classicAddress)
    const b = await swap({
      enveloppeSeq: sA,
      jambes: [jambeParts({ ticket: tA[0] }), jambePrix({ seq: sB })],
    })
    return sendRaw(c, b)
  })
  note('T1', 'jambe A sur TicketSequence, enveloppe sur Sequence', r)
}

// ─── T2 · enveloppe sur ticket ─────────────────────────────────────────────
console.log('\n══ T2 · l\'enveloppe du vendeur sur un Ticket ══')
{
  const r = await tente(async () => {
    const sA = await sequence(c, A.classicAddress), sB = await sequence(c, B.classicAddress)
    const b = await swap({
      enveloppeTicket: tA[1],
      jambes: [jambeParts({ seq: sA }), jambePrix({ seq: sB })],
    })
    return sendRaw(c, b)
  })
  note('T2', 'enveloppe sur TicketSequence, jambes sur Sequence', r)
}

// ─── T3 · tout sur tickets ─────────────────────────────────────────────────
console.log('\n══ T3 · enveloppe + les deux jambes sur Tickets ══')
{
  const r = await tente(async () => {
    const b = await swap({
      enveloppeTicket: tA[2],
      jambes: [jambeParts({ ticket: tA[3] }), jambePrix({ ticket: tB[0] })],
    })
    return sendRaw(c, b)
  })
  note('T3', 'plus aucune Sequence de compte engagée', r)
}

// ─── T4 · LE test : la pré-signature survit-elle au bruit ? ────────────────
console.log('\n══ T4 · DÉCISIF : pré-signé, puis les deux comptes transigent ailleurs ══')
{
  const r = await tente(async () => {
    // 1. le vendeur signe son offre MAINTENANT, sur tickets, fenêtre longue
    const b = await swap({
      enveloppeTicket: tA[4],
      jambes: [jambeParts({ ticket: tA[5] }), jambePrix({ ticket: tB[1] })],
      lls: 'long',
    })
    console.log('   offre signée et mise de côté.')

    // 2. la vie continue : chacun fait une transaction qui consomme sa séquence
    const bruitA = await submit(c, {
      TransactionType: 'Payment', Account: A.classicAddress,
      Destination: B.classicAddress, Amount: '100000',
    }, A)
    const bruitB = await submit(c, {
      TransactionType: 'Payment', Account: B.classicAddress,
      Destination: A.classicAddress, Amount: '100000',
    }, B)
    console.log(`   bruit : A ${bruitA.result} · B ${bruitB.result} — les deux séquences ont bougé.`)

    // 3. on soumet l'offre signée AVANT ce bruit
    return sendRaw(c, b)
  })
  note('T4', 'offre pré-signée soumise après que les deux comptes ont bougé', r,
    'si tesSUCCESS : une offre signée est durable → carnet possible')
}

// ─── T5 · fenêtre longue ───────────────────────────────────────────────────
console.log('\n══ T5 · LastLedgerSequence = li + 200 ══')
{
  const r = await tente(async () => {
    const sA = await sequence(c, A.classicAddress), sB = await sequence(c, B.classicAddress)
    const b = await swap({
      enveloppeSeq: sA,
      jambes: [jambeParts({ seq: sA + 1 }), jambePrix({ seq: sB })],
      lls: 'long',
    })
    return sendRaw(c, b)
  })
  note('T5', 'fenêtre ~10 min — y a-t-il un plafond ?', r)
}

// ─── T6 · aucune fenêtre ───────────────────────────────────────────────────
console.log('\n══ T6 · pas de LastLedgerSequence du tout ══')
{
  const r = await tente(async () => {
    const sA = await sequence(c, A.classicAddress), sB = await sequence(c, B.classicAddress)
    const b = await swap({
      enveloppeSeq: sA,
      jambes: [jambeParts({ seq: sA + 1 }), jambePrix({ seq: sB })],
      lls: 'aucun',
    })
    return sendRaw(c, b)
  })
  note('T6', 'enveloppe sans expiration', r)
}

// ─── Synthèse ──────────────────────────────────────────────────────────────
console.log('\n╔═══════════════════════════════════════════════════════════════════╗')
console.log('║  SYNTHÈSE                                                         ║')
console.log('╚═══════════════════════════════════════════════════════════════════╝')
for (const r of resultats) {
  console.log(`  ${r.id.padEnd(4)} ${String(r.code).padEnd(20)} ${r.quoi}`)
  if (r.lecture) console.log(`       ↳ ${r.lecture}`)
}
const t4 = resultats.find(r => r.id === 'T4')
console.log(`\n  VERDICT : ${t4?.code === 'tesSUCCESS'
  ? 'une offre signée SURVIT à l\'activité des comptes — le carnet est constructible.'
  : `l'offre pré-signée ne survit pas (${t4?.code}) — c'est la demande à formuler.`}`)

console.log(`\n  soldes finaux : A ${await xrpBalance(c, A.classicAddress)} · B ${await xrpBalance(c, B.classicAddress)}`)
await c.disconnect()
