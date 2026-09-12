/**
 * probes-marche/05 — le helper du SDK est-il réparé dans 5.2.0-beta.1 ?
 *
 *   node probes-marche/05-verif-beta1.mjs
 *
 * La beta.1 introduit une table d'encodeurs par rôle et route la co-signature
 * vers encodeForSigningCounterparty. On vérifie sur la chaîne, sans aucun
 * contournement : `signLoanSetByCounterparty` du SDK, tel quel.
 */
import { Client, Wallet, signLoanSetByCounterparty } from 'xrpl'
import { encodeForSigning } from 'ripple-binary-codec'
import { sign as kpSign } from 'ripple-keypairs'
import { connect, fundAccount, submit, createdIndex, sleep, rippleNow, txUrl } from '@secondwave/core'
import { createVault, createBroker, coverDeposit, deposit, waitForInvestment } from '@secondwave/vault'

const c = await connect()
console.log(`xrpl.js ${(await import('xrpl/package.json', { with: { type: 'json' } })).default.version}\n`)

console.log('1. Décor minimal…')
const owner = await fundAccount()
const emprunteur = await fundAccount()
await sleep(6000)

const v = await createVault(c, owner, { subscriptionIn: 90, investmentFor: 400, assetsMaximum: '0' })
console.log(`   VaultCreate     ${v.result}  ${v.vaultId?.slice(0, 16)}…`)
console.log(`   VaultDeposit    ${(await deposit(c, owner, v.vaultId, '40000000')).result}`)
const b = await createBroker(c, owner, v.vaultId, { debtMaximum: '20000000' })
console.log(`   LoanBrokerSet   ${b.result}  ${b.brokerId?.slice(0, 16)}…`)
console.log(`   CoverDeposit    ${(await coverDeposit(c, owner, b.brokerId, '5000000')).result}`)

const w = await waitForInvestment(v.vault)
console.log(`\n2. Attente de la phase Investment (${w}s)…\n`)

console.log('3. LoanSet via le helper du SDK, SANS contournement…')
const terms = {
  TransactionType: 'LoanSet',
  Account: emprunteur.classicAddress,
  LoanBrokerID: b.brokerId,
  Counterparty: owner.classicAddress,
  PrincipalRequested: '6000000',
  PaymentInterval: 120,
  PaymentTotal: 2,
  GracePeriod: 60,
  InterestRate: 50000,
}

// L'emprunteur signe d'abord — c'est le prérequis du helper.
const tx = await c.autofill(terms)
tx.SigningPubKey = emprunteur.publicKey
tx.TxnSignature = kpSign(encodeForSigning(tx), emprunteur.privateKey)

// ⭐ le helper publié, tel quel, aucun encodeur appelé à la main
const { tx_blob, hash } = signLoanSetByCounterparty(owner, tx)

const sub = await c.request({ command: 'submit', tx_blob })
console.log(`   soumission : ${sub.result.engine_result} — ${sub.result.engine_result_message}`)

let final = null
for (let i = 0; i < 20 && sub.result.engine_result === 'tesSUCCESS'; i++) {
  await sleep(2000)
  try {
    const t = await c.request({ command: 'tx', transaction: hash })
    if (t.result.validated) { final = t.result; break }
  } catch { /* pas encore */ }
}

if (final) {
  const loanId = createdIndex({ meta: final.meta }, 'Loan')
  console.log(`   validé     : ${final.meta?.TransactionResult}`)
  console.log(`   Loan créé  : ${loanId}`)
  console.log(`   ${txUrl(hash)}`)
  console.log(`\n   ✅ LE HELPER DU SDK FONCTIONNE — le contournement CPT\\0 n'est plus nécessaire.`)
} else {
  console.log(`\n   ❌ toujours cassé en 5.2.0-beta.1.`)
}

await c.disconnect()
