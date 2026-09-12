// Balayage GracePeriod × PaymentInterval pour cerner le temINVALID de LoanSet.
import fs from 'node:fs'
import { connect, submitLoanSet, Wallet, rippleNow } from '@secondwave/core'

const st = JSON.parse(fs.readFileSync(new URL('./state-g.json', import.meta.url), 'utf8'))
const c = await connect()
const O = Wallet.fromSeed(st.wallets.O.seed)
const BW2 = Wallet.fromSeed(st.wallets.BW2.seed)
console.log('red-now =', st.red - rippleNow(), 's')

const si = await c.request({ command: 'server_info' })
console.log('base_fee_xrp:', si.result.info.validated_ledger?.base_fee_xrp, '| load_factor:', si.result.info.load_factor)

const cases = [
  { grace: 0, interval: 120 },
  { grace: 30, interval: 120 },
  { grace: 59, interval: 120 },
  { grace: 60, interval: 120 },
  { grace: 61, interval: 120 },
  { grace: 120, interval: 120 },
  { grace: 121, interval: 120 },   // grace > interval ?
  { grace: 60, interval: 59 },     // interval < 60 ?
  { grace: 60, interval: 60 },
]
for (const k of cases) {
  if (st.red - rippleNow() < 100) { console.log('fenêtre Investment presque close, stop'); break }
  const r = await submitLoanSet(c, {
    TransactionType: 'LoanSet', Account: BW2.classicAddress, LoanBrokerID: st.B2,
    PrincipalRequested: '1000000', PaymentInterval: k.interval, PaymentTotal: 1,
    GracePeriod: k.grace, InterestRate: 0,
  }, BW2, O)
  console.log(`grace=${k.grace} interval=${k.interval} → ${r.result} ${r.message ?? ''}`)
}
await c.disconnect()
