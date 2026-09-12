// Z — pourquoi tecNO_PERMISSION sur impair/défaut dans le test d'intégration beta.1 ?
// Hypothèse : impair sur la PÉRIODE FINALE d'un prêt (dernière échéance) ou après
// un paiement se comporte autrement qu'en période intermédiaire.
// Décor : deux prêts jumeaux (interval 60, total 2, grace 60) —
//   LP  : échéance 1 payée à temps  → on impaire en période finale
//   LN  : jamais payé              → on impaire en période 1 (contrôle, = campagne G)
import {
  startCampaign, vaultCreate, depositTx, submit, safeLoanSet, createdIndex,
  rippleNow, sleep, XRP, MANAGE_FLAGS,
} from './_lib.mjs'

const cx = await startCampaign('z')
const { O, B1, B2 } = await cx.fundMany(['O', 'B1', 'B2'])

const sub = rippleNow() + 70
const red = sub + 600
const V = await vaultCreate(cx.client, O, {
  Asset: { currency: 'XRP' }, AssetsMaximum: '0', VaultKind: 1,
  SubscriptionDate: sub, RedemptionDate: red, WithdrawalPolicy: 1,
})
cx.rec('Z0', 'VaultCreate', '', V)
await submit(cx.client, depositTx(O, V.vaultId, XRP(40)), O)
const rb = await submit(cx.client, {
  TransactionType: 'LoanBrokerSet', Account: O.classicAddress, VaultID: V.vaultId,
  DebtMaximum: '0', CoverRateMinimum: 0, CoverRateLiquidation: 0, ManagementFeeRate: 0,
}, O)
const BK = createdIndex(rb, 'LoanBroker')
cx.rec('Z0.bk', 'broker 0/0', '', rb)

{ const w = sub - rippleNow() + 6; if (w > 0) { cx.log(`attente Investment (${w}s)…`); await sleep(w * 1000) } }

async function mkLoan(id, borrower) {
  const r = await safeLoanSet(cx.client, {
    TransactionType: 'LoanSet', Account: borrower.classicAddress, LoanBrokerID: BK,
    PrincipalRequested: XRP(6), PaymentInterval: 60, PaymentTotal: 2, GracePeriod: 60, InterestRate: 50000,
  }, borrower, O)
  cx.rec(id, 'LoanSet 6 XRP interval 60 total 2 grace 60', '', r)
  return createdIndex(r, 'Loan')
}
const LP = await mkLoan('Z.LP', B1)   // sera payé
const LN = await mkLoan('Z.LN', B2)   // jamais payé
const t0 = rippleNow()

// payer l'échéance 1 de LP AVANT sa due (due ≈ t0+60) — paiement en avance permis [X3]
const lp0 = await cx.entry(LP)
cx.note('Z', `LP: PeriodicPayment=${lp0.PeriodicPayment} Next=${lp0.NextPaymentDueDate} PayRemaining=${lp0.PaymentRemaining}`)
const pay1 = Math.ceil(Number(lp0.PeriodicPayment))
cx.rec('Z.pay', `LoanPay échéance 1 en avance (${pay1})`, '', await submit(cx.client, {
  TransactionType: 'LoanPay', Account: B1.classicAddress, LoanID: LP, Amount: String(pay1),
}, B1))
const lp1 = await cx.entry(LP)
cx.note('Z', `LP après paiement: Next=${lp1.NextPaymentDueDate} PayRemaining=${lp1.PaymentRemaining} TVO=${lp1.TotalValueOutstanding}`)

// attendre LA MÊME frontière pour les deux : due2(LP) = due1+60 ≈ due de LN +60
{
  const due2 = Number(lp1.NextPaymentDueDate)
  const w = due2 + 60 + 10 - rippleNow()   // due2 + grace + marge
  if (w > 0) { cx.log(`attente due2+grace (${w}s)…`); await sleep(w * 1000) }
}

// LN d'abord (contrôle : période 1 jamais payée, très en retard)
cx.rec('Z.impairLN', 'impair LN (jamais payé, période 1)', `retard ${rippleNow() - (t0 + 60)}s`, await submit(cx.client, {
  TransactionType: 'LoanManage', Account: O.classicAddress, LoanID: LN, Flags: MANAGE_FLAGS.IMPAIR,
}, O))
// LP ensuite (période FINALE, échéance 1 payée)
cx.rec('Z.impairLP', 'impair LP (période finale, éch.1 payée)', '', await submit(cx.client, {
  TransactionType: 'LoanManage', Account: O.classicAddress, LoanID: LP, Flags: MANAGE_FLAGS.IMPAIR,
}, O))
// et le défaut direct sur LP si l'impair est refusé
cx.rec('Z.defLP', 'default LP', '', await submit(cx.client, {
  TransactionType: 'LoanManage', Account: O.classicAddress, LoanID: LP, Flags: MANAGE_FLAGS.DEFAULT,
}, O))
const lpF = await cx.entry(LP).catch(() => null)
cx.note('Z', `LP final: ${lpF ? `Flags=${lpF.Flags} Next=${lpF.NextPaymentDueDate} TVO=${lpF.TotalValueOutstanding}` : 'objet supprimé'}`)

await cx.done()
