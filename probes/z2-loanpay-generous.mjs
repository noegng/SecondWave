// Z2 — un LoanPay « généreux » (4 XRP > périodique ~3) soumis À l'échéance
// solde-t-il tout le prêt ? (reproduction du tecNO_PERMISSION de l'intégration)
import {
  startCampaign, vaultCreate, depositTx, submit, safeLoanSet, createdIndex,
  rippleNow, sleep, XRP, MANAGE_FLAGS,
} from './_lib.mjs'

const cx = await startCampaign('z2')
const { O, B } = await cx.fundMany(['O', 'B'])
const bal = async a => BigInt((await cx.request({ command: 'account_info', account: a, ledger_index: 'validated' })).account_data.Balance)

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
cx.note('Z2', 'décor identique à l\'intégration (broker 10000/50000, cover 5)')

{ const w = sub - rippleNow() + 6; if (w > 0) { cx.log(`attente Investment (${w}s)…`); await sleep(w * 1000) } }

const rl = await safeLoanSet(cx.client, {
  TransactionType: 'LoanSet', Account: B.classicAddress, LoanBrokerID: BK,
  PrincipalRequested: XRP(6), PaymentInterval: 60, PaymentTotal: 2, GracePeriod: 60, InterestRate: 50000,
}, B, O)
const L = createdIndex(rl, 'Loan')
cx.rec('Z2.loan', 'LoanSet 6 XRP interval 60 total 2', '', rl)
const l0 = await cx.entry(L)
const t0 = rippleNow()
cx.note('Z2', `loan: Periodic=${l0.PeriodicPayment} Next=${l0.NextPaymentDueDate} (due dans ${Number(l0.NextPaymentDueDate) - t0}s) TVO=${l0.TotalValueOutstanding}`)

// attendre due+2s wall-clock, comme l'intégration (sleep 62 après le LoanSet)
{
  const w = Number(l0.NextPaymentDueDate) + 2 - rippleNow()
  if (w > 0) { cx.log(`attente due+2s (${w}s)…`); await sleep(w * 1000) }
}
const b0 = await bal(B.classicAddress)
const rp = await submit(cx.client, { TransactionType: 'LoanPay', Account: B.classicAddress, LoanID: L, Amount: XRP(4) }, B)
const b1 = await bal(B.classicAddress)
cx.rec('Z2.pay', `LoanPay 4 XRP à due+2s wall (généreux, sans flag)`, '', rp, '', `réellement débité: ${b0 - b1} drops (dont fee tx)`)
const l1 = await cx.entry(L).catch(() => null)
cx.note('Z2', `loan après: ${l1 ? `Next=${l1.NextPaymentDueDate} PayRemaining=${l1.PaymentRemaining} TVO=${l1.TotalValueOutstanding} Flags=${l1.Flags}` : 'OBJET SUPPRIMÉ'}`)
const v1 = (await cx.request({ command: 'vault_info', vault_id: V.vaultId })).vault
cx.note('Z2', `vault: AssetsTotal=${v1.AssetsTotal} AssetsAvailable=${v1.AssetsAvailable}`)

// l'impair, avec marge ledger confortable si le prêt vit encore
if (l1 && l1.TotalValueOutstanding != null) {
  const w = Number(l1.NextPaymentDueDate) + Number(l1.GracePeriod) + 20 - rippleNow()
  if (w > 0) { cx.log(`attente due2+grace+20 (${w}s)…`); await sleep(w * 1000) }
}
cx.rec('Z2.impair', 'tfLoanImpair', '', await submit(cx.client, {
  TransactionType: 'LoanManage', Account: O.classicAddress, LoanID: L, Flags: MANAGE_FLAGS.IMPAIR,
}, O))
cx.rec('Z2.default', 'tfLoanDefault', '', await submit(cx.client, {
  TransactionType: 'LoanManage', Account: O.classicAddress, LoanID: L, Flags: MANAGE_FLAGS.DEFAULT,
}, O))

await cx.done()
