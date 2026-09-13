/**
 * Jusqu'où peut-on repousser l'échéance d'un Batch ?
 *
 * Une offre sans `LastLedgerSequence` ne meurt jamais (sonde 13/T6). C'est ce
 * qui rend le carnet possible — mais ça donne au vendeur une OPTION GRATUITE :
 * l'acheteur a signé, le vendeur exécute quand ça l'arrange, y compris dans un
 * an, y compris quand le vault s'est effondré entre-temps.
 *
 * L'antidote n'est pas de supprimer l'échéance, c'est de la déplacer : aucune
 * sur l'ANNONCE (qui n'engage personne), une sur l'ENGAGEMENT de l'acheteur.
 * Reste à savoir quelle durée rippled accepte.
 *
 *   F1   li + 200        ~10 min
 *   F2   li + 1 250      ~1 h
 *   F3   li + 30 000     ~24 h
 *   F4   li + 210 000    ~7 jours
 *   F5   li + 99 999 999 absurde — y a-t-il un plafond ?
 *
 * On ne soumet pas : `submit` valide l'enveloppe et renvoie son verdict sans
 * qu'on ait besoin de dépenser. Un `tesSUCCESS` signifie acceptée.
 */
import { BatchFlags, signMultiBatch, encodeForSigning, kpSign, sendRaw, TF_INNER } from './_lib.mjs'
import { connect, fundAccount, submit, sleep } from '@secondwave/core'

const c = await connect()
const resultats = []

console.log('Financement…')
const A = await fundAccount()
const B = await fundAccount()
await sleep(4000)

async function tickets(w, n) {
  const r = await submit(c, { TransactionType: 'TicketCreate', Account: w.classicAddress, TicketCount: n }, w)
  if (!r.ok) throw new Error(`TicketCreate: ${r.result}`)
  const o = await c.request({ command: 'account_objects', account: w.classicAddress, type: 'ticket', ledger_index: 'validated' })
  return o.result.account_objects.map(x => x.TicketSequence).sort((a, b) => a - b)
}
const tA = await tickets(A, 6)
const tB = await tickets(B, 6)

const li = (await c.request({ command: 'ledger', ledger_index: 'validated' })).result.ledger_index
const SEC_PAR_LEDGER = 2.88

function offre({ enveloppe, jA, jB, lls }) {
  const jambe = t => ({ RawTransaction: { ...t, Fee: '0', SigningPubKey: '', Flags: TF_INNER } })
  const batch = {
    TransactionType: 'Batch', Account: A.classicAddress, Flags: BatchFlags.tfAllOrNothing,
    Sequence: 0, TicketSequence: enveloppe, Fee: '150',
    RawTransactions: [
      jambe({ TransactionType: 'Payment', Account: A.classicAddress, Destination: B.classicAddress,
              Amount: '1000000', Sequence: 0, TicketSequence: jA }),
      jambe({ TransactionType: 'Payment', Account: B.classicAddress, Destination: A.classicAddress,
              Amount: '2000000', Sequence: 0, TicketSequence: jB }),
    ],
    ...(lls == null ? {} : { LastLedgerSequence: lls }),
  }
  signMultiBatch(B, batch)
  batch.SigningPubKey = A.publicKey
  batch.TxnSignature = kpSign(encodeForSigning(batch), A.privateKey)
  return batch
}

const CAS = [
  ['F1', 200, '~10 min'],
  ['F2', 1_250, '~1 h'],
  ['F3', 30_000, '~24 h'],
  ['F4', 210_000, '~7 jours'],
  ['F5', 99_999_999 - li, 'absurde (LLS = 99 999 999)'],
]

for (let i = 0; i < CAS.length; i++) {
  const [id, offset, label] = CAS[i]
  const duree = (offset * SEC_PAR_LEDGER / 3600).toFixed(1)
  let code, msg = ''
  try {
    const b = offre({ enveloppe: tA[i], jA: tA[i], jB: tB[i], lls: li + offset })
    // ⚠️ même ticket pour l'enveloppe et la jambe : on ne cherche PAS à régler,
    //    seulement à savoir si l'enveloppe est acceptée telle quelle.
    const r = await sendRaw(c, b)
    code = r.engine ?? r.result ?? '?'
    msg = r.message ?? ''
  } catch (e) {
    code = 'SDK-REJET'; msg = e.message
  }
  resultats.push({ id, offset, label, duree, code })
  console.log(`  [${id}] ${String(code).padEnd(20)} li+${String(offset).padEnd(10)} ${label} (${duree} h)`)
  if (msg) console.log(`        ${msg.slice(0, 110)}`)
}

console.log('\n╔══════════════════════════════════════════════════════════════════╗')
console.log('║  Jusqu\'où peut-on repousser l\'échéance ?                          ║')
console.log('╚══════════════════════════════════════════════════════════════════╝')
for (const r of resultats)
  console.log(`  ${r.id}  ${String(r.code).padEnd(20)} ${r.label.padEnd(28)} ${r.duree} h`)

const refuses = resultats.filter(r => !/^tes|^tec/.test(r.code))
console.log(`\n  ${refuses.length
  ? `plafond détecté : refus à partir de ${refuses[0].label} (${refuses[0].code})`
  : 'aucun plafond observé — l\'échéance est libre, c\'est un choix de produit.'}`)
await c.disconnect()
