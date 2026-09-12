// Z3 — reproduction EXACTE du timing de l'intégration :
//   LoanSet (interval 60, total 2) → sleep 62 → LoanPay 4 XRP (généreux)
// Deux runs l'ont vu « solder » le prêt (champs purgés) puis refuser impair/défaut
// en tecNO_PERMISSION. On capture tout : loan JSON complet + meta du LoanPay.
import {
  startCampaign, vaultCreate, depositTx, submit, safeLoanSet, createdIndex,
  rippleNow, sleep, XRP, MANAGE_FLAGS,
} from './_lib.mjs'

const cx = await startCampaign('z3')
const { O, B } = await cx.fundMany(['O', 'B'])

const sub = rippleNow() + 65
const red = sub + 500
const V = await vaultCreate(cx.client, O, {
  Asset: { currency: 'XRP' }, AssetsMaximum: '0', VaultKind: 1,
  SubscriptionDate: sub, RedemptionDate: red, WithdrawalPolicy: 1,
})
await submit(cx.client, depositTx(O, V.vaultId, XRP(40)), O)
const rb = await submit(cx.client, {
  TransactionType: 'LoanBrokerSet', Account: O.classicAddress, VaultID: V.vaultId,
  DebtMaximum: XRP(20), CoverRateMinimum: 10000, CoverRateLiquidation: 50000, ManagementFeeRate: 0,
}, O)
const BK = createdIndex(rb, 'LoanBroker')
await submit(cx.client, { TransactionType: 'LoanBrokerCoverDeposit', Account: O.classicAddress, LoanBrokerID: BK, Amount: XRP(5) }, O)

{ const w = sub - rippleNow() + 6; if (w > 0) { cx.log(`attente Investment (${w}s)…`); await sleep(w * 1000) } }

const rl = await safeLoanSet(cx.client, {
  TransactionType: 'LoanSet', Account: B.classicAddress, LoanBrokerID: BK,
  PrincipalRequested: XRP(6), PaymentInterval: 60, PaymentTotal: 2, GracePeriod: 60, InterestRate: 50000,
}, B, O)
const L = createdIndex(rl, 'Loan')
cx.rec('Z3.loan', 'LoanSet 6 XRP interval 60 total 2 grace 60', '', rl)
const l0 = await cx.entry(L)
cx.note('Z3', `créé: Next=${l0.NextPaymentDueDate} (now=${rippleNow()}, due dans ${Number(l0.NextPaymentDueDate) - rippleNow()}s) Periodic=${l0.PeriodicPayment}`)

cx.log('sleep 62s (timing exact de l\'intégration)…')
await sleep(62000)

cx.note('Z3', `pay à now=${rippleNow()} (due${Number(l0.NextPaymentDueDate) - rippleNow() >= 0 ? '-' : '+'}${Math.abs(rippleNow() - Number(l0.NextPaymentDueDate))}s wall)`)
const rp = await submit(cx.client, { TransactionType: 'LoanPay', Account: B.classicAddress, LoanID: L, Amount: XRP(4) }, B)
cx.rec('Z3.pay', 'LoanPay 4 XRP (généreux) à wall≈due+2', '', rp)
if (rp.meta) {
  const deltas = []
  for (const n of rp.meta.AffectedNodes ?? []) {
    const [kind, node] = Object.entries(n)[0]
    if (node.LedgerEntryType === 'AccountRoot') {
      const before = node.PreviousFields?.Balance, after = node.FinalFields?.Balance
      if (before != null) deltas.push(`${node.FinalFields.Account.slice(0, 8)}: ${BigInt(after) - BigInt(before)}`)
    }
    if (node.LedgerEntryType === 'Loan') deltas.push(`Loan(${kind}): ${JSON.stringify(node.FinalFields ?? node.NewFields ?? {})}`)
  }
  cx.note('Z3.meta', deltas.join(' | '))
}
const l1 = await cx.entry(L).catch(() => null)
cx.note('Z3', `loan APRÈS pay (JSON complet): ${JSON.stringify(l1)}`)

// impair/défaut avec marge confortable
if (l1) {
  const due2 = Number(l1.NextPaymentDueDate ?? l0.NextPaymentDueDate)
  const w = due2 + 60 + 20 - rippleNow()
  if (w > 0) { cx.log(`attente due2+grace+20 (${w}s)…`); await sleep(w * 1000) }
}
cx.rec('Z3.impair', 'tfLoanImpair', `now=${rippleNow()}`, await submit(cx.client, {
  TransactionType: 'LoanManage', Account: O.classicAddress, LoanID: L, Flags: MANAGE_FLAGS.IMPAIR,
}, O))
cx.rec('Z3.default', 'tfLoanDefault', '', await submit(cx.client, {
  TransactionType: 'LoanManage', Account: O.classicAddress, LoanID: L, Flags: MANAGE_FLAGS.DEFAULT,
}, O))
cx.note('Z3', `loan final: ${JSON.stringify(await cx.entry(L).catch(() => 'supprimé'))}`)

await cx.done()
