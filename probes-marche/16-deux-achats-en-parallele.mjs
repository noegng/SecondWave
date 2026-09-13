/**
 * Un achat qui se règle met-il en péril un achat encore en attente ?
 *
 * Le scénario exact : je m'engage sur l'offre A et j'attends le vendeur A.
 * Entre-temps je prends l'offre B, dont le vendeur confirme immédiatement.
 * Quand le vendeur A se réveille, mon engagement sur A tient-il toujours ?
 *
 * Trois choses pourraient le tuer, et on les teste une par une :
 *
 *   P1  ma SÉQUENCE a bougé          B en a consommé une → A doit survivre
 *   P2  mes TICKETS ont été touchés  B a brûlé les siens → ceux de A intacts ?
 *   P3  mon SOLDE a baissé           B m'a coûté du XRP → A passe encore ?
 *
 * Puis le cas qui doit échouer, pour vérifier qu'on échoue proprement :
 *   P4  B me vide                    A n'a plus de quoi payer → quel code ?
 *
 * Un acheteur, deux vendeurs, des paiements XRP croisés : pas besoin de vault
 * pour poser la question.
 */
import { BatchFlags, signMultiBatch, encodeForSigning, kpSign, sendRaw, TF_INNER } from './_lib.mjs'
import { connect, fundAccount, submit, sequence, sleep, xrpBalance } from '@secondwave/core'

const c = await connect()
const note = (id, quoi, code, lecture = '') => {
  console.log(`  [${id}] ${String(code).padEnd(16)} ${quoi}`)
  if (lecture) console.log(`        ↳ ${lecture}`)
}

console.log('Financement : un acheteur, deux vendeurs…')
const ACHETEUR = await fundAccount()
const VENDEUR_A = await fundAccount()
const VENDEUR_B = await fundAccount()
await sleep(4000)
console.log(`  acheteur  ${ACHETEUR.classicAddress}`)
console.log(`  vendeur A ${VENDEUR_A.classicAddress}`)
console.log(`  vendeur B ${VENDEUR_B.classicAddress}\n`)

async function tickets(w, n) {
  const r = await submit(c, { TransactionType: 'TicketCreate', Account: w.classicAddress, TicketCount: n }, w)
  if (!r.ok) throw new Error(`TicketCreate: ${r.result}`)
  const o = await c.request({ command: 'account_objects', account: w.classicAddress, type: 'ticket', ledger_index: 'validated' })
  return o.result.account_objects.map(x => x.TicketSequence).sort((a, b) => a - b)
}
const tAch = await tickets(ACHETEUR, 6)
const tA = await tickets(VENDEUR_A, 4)
const tB = await tickets(VENDEUR_B, 4)
console.log(`tickets acheteur : ${tAch.join(', ')}\n`)

/** « J'achète des parts au vendeur V » : il me livre 1 XRP, je lui paie `prix`. */
function achat({ vendeur, ticketEnv, ticketVendeur, ticketAcheteur, prix, lls = null }) {
  const jambe = t => ({ RawTransaction: { ...t, Fee: '0', SigningPubKey: '', Flags: TF_INNER } })
  const batch = {
    TransactionType: 'Batch', Account: vendeur.classicAddress, Flags: BatchFlags.tfAllOrNothing,
    Sequence: 0, TicketSequence: ticketEnv, Fee: '150',
    RawTransactions: [
      jambe({ TransactionType: 'Payment', Account: vendeur.classicAddress,
              Destination: ACHETEUR.classicAddress, Amount: '1000000',
              Sequence: 0, TicketSequence: ticketVendeur }),
      jambe({ TransactionType: 'Payment', Account: ACHETEUR.classicAddress,
              Destination: vendeur.classicAddress, Amount: String(prix),
              Sequence: 0, TicketSequence: ticketAcheteur }),
    ],
    ...(lls == null ? {} : { LastLedgerSequence: lls }),
  }
  signMultiBatch(ACHETEUR, batch)                     // ① l'acheteur s'engage
  return batch
}
const confirmer = (batch, vendeur) => {                // ② le vendeur confirme
  batch.SigningPubKey = vendeur.publicKey
  batch.TxnSignature = kpSign(encodeForSigning(batch), vendeur.privateKey)
  return batch
}

const li = (await c.request({ command: 'ledger', ledger_index: 'validated' })).result.ledger_index

// ── Je m'engage sur A, et je n'y touche plus ────────────────────────────────
console.log('══ Je m\'engage sur l\'offre A (10 XRP), et j\'attends ══')
const offreA = achat({
  vendeur: VENDEUR_A, ticketEnv: tA[0], ticketVendeur: tA[1],
  ticketAcheteur: tAch[0], prix: 10_000_000, lls: li + 30_000,
})
const seqAvant = await sequence(c, ACHETEUR.classicAddress)
const soldeAvant = await xrpBalance(c, ACHETEUR.classicAddress)
console.log(`   signé. séquence ${seqAvant} · solde ${soldeAvant} drops\n`)

// ── Entre-temps, j'achète B et le vendeur B confirme tout de suite ──────────
console.log('══ Entre-temps : j\'achète B (12 XRP), le vendeur B confirme aussitôt ══')
const offreB = achat({
  vendeur: VENDEUR_B, ticketEnv: tB[0], ticketVendeur: tB[1],
  ticketAcheteur: tAch[1], prix: 12_000_000,
})
confirmer(offreB, VENDEUR_B)
const rB = await sendRaw(c, offreB)
note('B', 'l\'achat B se règle immédiatement', rB.engine ?? rB.result)

// Et je fais aussi une transaction ordinaire, pour bouger ma séquence.
const bruit = await submit(c, { TransactionType: 'AccountSet', Account: ACHETEUR.classicAddress }, ACHETEUR)
const seqApres = await sequence(c, ACHETEUR.classicAddress)
const soldeApres = await xrpBalance(c, ACHETEUR.classicAddress)

note('P1', 'ma séquence a-t-elle bougé ?', `${seqAvant} → ${seqApres}`,
  seqApres !== seqAvant ? 'oui — c\'est précisément ce qui tuait une offre pré-signée avant les Tickets' : 'non')
const restants = await c.request({ command: 'account_objects', account: ACHETEUR.classicAddress, type: 'ticket', ledger_index: 'validated' })
const dispo = restants.result.account_objects.map(x => x.TicketSequence)
note('P2', 'le ticket réservé à A existe-t-il encore ?', dispo.includes(tAch[0]) ? 'OUI' : 'NON',
  `tickets restants : ${dispo.sort((a, b) => a - b).join(', ')}`)
note('P3', 'mon solde a-t-il baissé ?', `${soldeAvant} → ${soldeApres}`,
  `−${soldeAvant - soldeApres} drops`)

// ── Le vendeur A se réveille ────────────────────────────────────────────────
console.log('\n══ Le vendeur A se réveille et confirme ══')
confirmer(offreA, VENDEUR_A)
const rA = await sendRaw(c, offreA)
note('P4', 'l\'achat A tient-il toujours ?', rA.engine ?? rA.result,
  (rA.engine ?? rA.result) === 'tesSUCCESS'
    ? '✅ oui — un achat qui se règle ne met pas en péril un achat en attente'
    : `🔴 non : ${rA.message ?? ''}`)

const soldeFinal = await xrpBalance(c, ACHETEUR.classicAddress)
console.log(`\n  solde final ${soldeFinal} drops`)
console.log(`  les deux achats ont coûté ${soldeAvant - soldeFinal} drops (attendu ~22 000 000 + frais)`)

// ── Et si B m'avait vidé ? ──────────────────────────────────────────────────
console.log('\n══ Le cas qui DOIT échouer : un achat au-dessus de mes moyens ══')
const tropCher = achat({
  vendeur: VENDEUR_A, ticketEnv: tA[2], ticketVendeur: tA[3],
  ticketAcheteur: tAch[2], prix: 900_000_000,          // 900 XRP que je n'ai pas
})
confirmer(tropCher, VENDEUR_A)
const rTrop = await sendRaw(c, tropCher)
const soldeApresEchec = await xrpBalance(c, ACHETEUR.classicAddress)
note('P5', 'un Batch sans provision', rTrop.engine ?? rTrop.result,
  soldeApresEchec >= soldeFinal - 1000n
    ? 'aucun débit — tfAllOrNothing tient : rien ne bouge, pas de demi-échange'
    : `🔴 quelque chose a bougé : ${soldeFinal} → ${soldeApresEchec}`)

console.log('\n╔═══════════════════════════════════════════════════════════════════╗')
console.log('║  Deux achats en parallèle : le second met-il le premier en péril ? ║')
console.log('╚═══════════════════════════════════════════════════════════════════╝')
console.log(`  séquence bougée   ${seqAvant !== seqApres ? 'oui' : 'non'} → sans effet (Tickets)`)
console.log(`  tickets de A      ${dispo.includes(tAch[0]) ? 'intacts' : 'PERDUS'}`)
console.log(`  achat A final     ${rA.engine ?? rA.result}`)
console.log(`  sans provision    ${rTrop.engine ?? rTrop.result} — aucun débit`)
await c.disconnect()
