// Repro du temINVALID sur LoanSet — réutilise le décor de la campagne G.
import fs from 'node:fs'
import { connect, submitLoanSet, sequence, Wallet, rippleNow, sleep, counterpartySign } from '@secondwave/core'
import { encode, encodeForSigning } from 'ripple-binary-codec'
import { sign as kpSign } from 'ripple-keypairs'

const st = JSON.parse(fs.readFileSync(new URL('./state-g.json', import.meta.url), 'utf8'))
const c = await connect()
const O = Wallet.fromSeed(st.wallets.O.seed)
const BW = Wallet.fromSeed(st.wallets.BW.seed)
console.log('phase check: now-sub =', rippleNow() - st.sub, 'red-now =', st.red - rippleNow())

// 1. reproduction telle quelle (interval 60 total 2 grace 30)
const terms = {
  TransactionType: 'LoanSet', Account: BW.classicAddress, LoanBrokerID: st.B1,
  PrincipalRequested: '4000000', PaymentInterval: 60, PaymentTotal: 2, GracePeriod: 30, InterestRate: 50000,
}
const r1 = await submitLoanSet(c, terms, BW, O)
console.log('repro (via core):', r1.result, '—', r1.message ?? '')

// 2. à la main, en loggant la tx exacte et en essayant des Fee différents
for (const fee of [null, '20', '100']) {
  const tx = await c.autofill({ ...terms, Counterparty: O.classicAddress })
  if (fee) tx.Fee = fee
  console.log(`\n--- essai Fee=${tx.Fee} Sequence=${tx.Sequence} LLS=${tx.LastLedgerSequence} ---`)
  tx.SigningPubKey = BW.publicKey
  tx.TxnSignature = kpSign(encodeForSigning(tx), BW.privateKey)
  tx.CounterpartySignature = { SigningPubKey: O.publicKey, TxnSignature: counterpartySign(tx, O) }
  const sub = await c.request({ command: 'submit', tx_blob: encode(tx) })
  console.log('engine:', sub.result.engine_result, '—', sub.result.engine_result_message)
  if (sub.result.engine_result === 'tesSUCCESS') {
    console.log('tx qui PASSE:', JSON.stringify({ ...tx, TxnSignature: '...', CounterpartySignature: '...' }))
    break
  } else {
    console.log('tx qui échoue:', JSON.stringify({ ...tx, TxnSignature: '...', CounterpartySignature: { ...tx.CounterpartySignature, TxnSignature: '...' } }))
  }
  await sleep(1000)
}
await c.disconnect()
