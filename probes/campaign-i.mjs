// Campagne I — actifs autres que XRP : IOU (100-102, 105-106) et MPT (103-104).
import fs from 'node:fs'
import {
  startCampaign, vaultCreate, depositTx, withdrawTx,
  submit, safeLoanSet, createdIndex, rippleNow, sleep, XRP, hex, shareBalance,
} from './_lib.mjs'

const cx = await startCampaign('i')
const { IS, O, D, BW, M } = await cx.fundMany(['IS', 'O', 'D', 'BW', 'M'])
const iou = v => ({ currency: 'USD', issuer: IS.classicAddress, value: String(v) })
const usdBal = async a => {
  const l = (await cx.request({ command: 'account_lines', account: a, ledger_index: 'validated' })).lines
  return l.find(x => x.currency === 'USD')?.balance ?? '0'
}

// ── décor IOU : DefaultRipple + clawback + trustlines (PAS pour M : cas 105)
await submit(cx.client, { TransactionType: 'AccountSet', Account: IS.classicAddress, SetFlag: 8 }, IS)
await submit(cx.client, { TransactionType: 'AccountSet', Account: IS.classicAddress, SetFlag: 16 }, IS)
for (const [w, amt] of [[O, '200'], [D, '500'], [BW, '100']]) {
  await submit(cx.client, { TransactionType: 'TrustSet', Account: w.classicAddress, LimitAmount: { currency: 'USD', issuer: IS.classicAddress, value: '100000' } }, w)
  await submit(cx.client, { TransactionType: 'Payment', Account: IS.classicAddress, Destination: w.classicAddress, Amount: iou(amt) }, IS)
}
cx.note('I0', 'IS émet USD (DefaultRipple + AllowTrustLineClawback), O/D/BW ont une trustline, M NON')

// ── 100 : vault IOU closed-ended, cycle complet
const sub = rippleNow() + 100
const red = sub + 480
const V = await vaultCreate(cx.client, O, {
  Asset: { currency: 'USD', issuer: IS.classicAddress }, AssetsMaximum: '0', VaultKind: 1,
  SubscriptionDate: sub, RedemptionDate: red, WithdrawalPolicy: 1, Scale: 6,
})
cx.rec('100.create', 'VaultCreate IOU USD Scale 6 closed-ended', '', V)
cx.rec('100.dep', 'D dépose 100 USD', '', await submit(cx.client, depositTx(D, V.vaultId, iou('100')), D))
{
  const sb = await shareBalance(cx.client, D.classicAddress, V.mptId)
  cx.note('101', `parts de D pour 100 USD en Scale 6: ${sb.amount} (attendu 100e6 si parts = USD×10^6)`)
}
const rb = await submit(cx.client, {
  TransactionType: 'LoanBrokerSet', Account: O.classicAddress, VaultID: V.vaultId,
  DebtMaximum: '0', CoverRateMinimum: 10000, CoverRateLiquidation: 50000, ManagementFeeRate: 0,
}, O)
const BID = createdIndex(rb, 'LoanBroker')
cx.rec('100.broker', 'LoanBrokerSet sur vault IOU', '', rb)
cx.rec('100.cover', 'CoverDeposit 20 USD', '', await submit(cx.client, {
  TransactionType: 'LoanBrokerCoverDeposit', Account: O.classicAddress, LoanBrokerID: BID, Amount: iou('20'),
}, O))
cx.saveState({ V: V.vaultId, mptId: V.mptId, BID, sub, red })

// ── 102 : VaultClawback par l'émetteur (pendant la Subscription, D a des parts)
{
  const v0 = (await cx.request({ command: 'vault_info', vault_id: V.vaultId })).vault
  const sb0 = await shareBalance(cx.client, D.classicAddress, V.mptId)
  const r = await submit(cx.client, {
    TransactionType: 'VaultClawback', Account: IS.classicAddress, VaultID: V.vaultId,
    Holder: D.classicAddress, Amount: iou('30'),
  }, IS)
  const v1 = (await cx.request({ command: 'vault_info', vault_id: V.vaultId })).vault
  const sb1 = await shareBalance(cx.client, D.classicAddress, V.mptId)
  cx.rec('102', 'VaultClawback 30 USD par l\'émetteur sur la position de D', '', r,
    r.ok ? 'surprenant' : '',
    `AssetsTotal ${v0.AssetsTotal}→${v1.AssetsTotal} | parts D ${sb0.amount}→${sb1.amount} | trustline D=${await usdBal(D.classicAddress)}`)
  // clawback de plus que la position ?
  cx.rec('102.over', 'VaultClawback 500 USD (plus que la position restante)', '', await submit(cx.client, {
    TransactionType: 'VaultClawback', Account: IS.classicAddress, VaultID: V.vaultId,
    Holder: D.classicAddress, Amount: iou('500'),
  }, IS))
  const sb2 = await shareBalance(cx.client, D.classicAddress, V.mptId)
  cx.note('102', `parts D après clawback excessif: ${sb2.amount}`)
  // re-provisionner pour la suite
  cx.rec('102.refill', 'D redépose 100 USD', '', await submit(cx.client, depositTx(D, V.vaultId, iou('100')), D))
}
// cover clawback
{
  const b0 = await cx.entry(BID)
  const r = await submit(cx.client, {
    TransactionType: 'LoanBrokerCoverClawback', Account: IS.classicAddress, LoanBrokerID: BID, Amount: iou('5'),
  }, IS)
  const b1 = await cx.entry(BID)
  cx.rec('102.cover', 'LoanBrokerCoverClawback 5 USD par l\'émetteur', '', r, r.ok ? 'surprenant' : '',
    `CoverAvailable ${b0.CoverAvailable}→${b1.CoverAvailable}`)
}

// ══ Investment ══
{
  const wait = sub - rippleNow() + 6
  if (wait > 0) { cx.log(`attente Investment (${wait}s)…`); await sleep(wait * 1000) }
}

// ── 105 : emprunteur SANS trustline
cx.rec('105', 'LoanSet 10 USD par M (aucune trustline USD)', '', await safeLoanSet(cx.client, {
  TransactionType: 'LoanSet', Account: M.classicAddress, LoanBrokerID: BID,
  PrincipalRequested: '10', PaymentInterval: 120, PaymentTotal: 1, GracePeriod: 60, InterestRate: 0,
}, M, O))

// ── 100 suite : prêt IOU par BW (trustline OK)
const rl = await safeLoanSet(cx.client, {
  TransactionType: 'LoanSet', Account: BW.classicAddress, LoanBrokerID: BID,
  PrincipalRequested: '50', PaymentInterval: 90, PaymentTotal: 1, GracePeriod: 60, InterestRate: 50000,
}, BW, O)
const LID = createdIndex(rl, 'Loan')
cx.rec('100.loan', 'LoanSet 50 USD par BW', '', rl, '', `trustline BW=${await usdBal(BW.classicAddress)}`)

// ── 106 : GEL GLOBAL pendant la vie du vault
cx.rec('106.freeze', 'AccountSet asfGlobalFreeze par IS', '', await submit(cx.client, {
  TransactionType: 'AccountSet', Account: IS.classicAddress, SetFlag: 7,
}, IS))
cx.rec('106.dep', 'dépôt IOU sous gel global (phase Investment, contrôle de code)', '', await submit(cx.client, depositTx(D, V.vaultId, iou('5')), D))
if (LID) cx.rec('106.pay', 'LoanPay 20 USD sous gel global', '', await submit(cx.client, {
  TransactionType: 'LoanPay', Account: BW.classicAddress, LoanID: LID, Amount: '20',
}, BW))
cx.rec('106.wd', 'retrait sous gel (Investment → code de phase ou de gel ?)', '', await submit(cx.client, withdrawTx(D, V.vaultId, V.mptId, 1_000_000), D))
cx.rec('106.unfreeze', 'levée du gel', '', await submit(cx.client, {
  TransactionType: 'AccountSet', Account: IS.classicAddress, ClearFlag: 7,
}, IS))
if (LID) {
  const r = await submit(cx.client, { TransactionType: 'LoanPay', Account: BW.classicAddress, LoanID: LID, Amount: '20' }, BW)
  cx.rec('106.pay2', 'LoanPay 20 USD après dégel (contrôle)', '', r)
}

// ══ 103 : vault sur MPT, cycle complet ══
cx.log('\n=== 103. vault sur MPT ===')
const rmpt = await submit(cx.client, {
  TransactionType: 'MPTokenIssuanceCreate', Account: M.classicAddress, AssetScale: 2, Flags: 32,
}, M)
const MPTLI = createdIndex(rmpt, 'MPTokenIssuance')
const mptId = rmpt.meta?.mpt_issuance_id ?? (MPTLI ? (await cx.entry(MPTLI)).mpt_issuance_id : null)
cx.rec('103.issue', 'MPTokenIssuanceCreate (M, scale 2, CanTransfer)', '', rmpt, '', `id=${mptId}`)
for (const [w, n] of [[O, 'O'], [D, 'D']]) {
  await submit(cx.client, { TransactionType: 'MPTokenAuthorize', Account: w.classicAddress, MPTokenIssuanceID: mptId }, w)
  await submit(cx.client, { TransactionType: 'Payment', Account: M.classicAddress, Destination: w.classicAddress, Amount: { mpt_issuance_id: mptId, value: '10000' } }, M)
  cx.note('103', `${n} approvisionné en MPT`)
}
const sub2 = rippleNow() + 70
const red2 = sub2 + 300
const VM = await vaultCreate(cx.client, O, {
  Asset: { mpt_issuance_id: mptId }, AssetsMaximum: '0', VaultKind: 1,
  SubscriptionDate: sub2, RedemptionDate: red2, WithdrawalPolicy: 1,
})
cx.rec('103.create', 'VaultCreate sur MPT closed-ended', '', VM)
if (VM.vaultId) {
  cx.rec('103.dep', 'D dépose 5000 unités MPT', '', await submit(cx.client, depositTx(D, VM.vaultId, { mpt_issuance_id: mptId, value: '5000' }), D))
  const rb2 = await submit(cx.client, {
    TransactionType: 'LoanBrokerSet', Account: O.classicAddress, VaultID: VM.vaultId,
    DebtMaximum: '0', CoverRateMinimum: 0, CoverRateLiquidation: 0, ManagementFeeRate: 0,
  }, O)
  const BID2 = createdIndex(rb2, 'LoanBroker')
  cx.rec('103.broker', 'LoanBrokerSet sur vault MPT', '', rb2)

  // 104 : un vault dont l'actif est le MPT de PARTS d'un autre vault
  cx.rec('104', 'VaultCreate dont l\'actif = parts (ShareMPTID) du vault IOU', '', await vaultCreate(cx.client, O, {
    Asset: { mpt_issuance_id: V.mptId }, AssetsMaximum: '0', WithdrawalPolicy: 1,
  }))

  {
    const wait = sub2 - rippleNow() + 6
    if (wait > 0) { cx.log(`attente Investment MPT (${wait}s)…`); await sleep(wait * 1000) }
  }
  // BW n'a PAS de MPToken → l'analogue MPT du cas 105
  cx.rec('103.loanNoAuth', 'LoanSet 2000 MPT par BW (PAS de MPToken)', '', await safeLoanSet(cx.client, {
    TransactionType: 'LoanSet', Account: BW.classicAddress, LoanBrokerID: BID2,
    PrincipalRequested: '2000', PaymentInterval: 90, PaymentTotal: 1, GracePeriod: 60, InterestRate: 0,
  }, BW, O))
  await submit(cx.client, { TransactionType: 'MPTokenAuthorize', Account: BW.classicAddress, MPTokenIssuanceID: mptId }, BW)
  const rl2 = await safeLoanSet(cx.client, {
    TransactionType: 'LoanSet', Account: BW.classicAddress, LoanBrokerID: BID2,
    PrincipalRequested: '2000', PaymentInterval: 90, PaymentTotal: 1, GracePeriod: 60, InterestRate: 0,
  }, BW, O)
  const LID2 = createdIndex(rl2, 'Loan')
  cx.rec('103.loan', 'LoanSet 2000 MPT par BW (après MPTokenAuthorize)', '', rl2)
  if (LID2) {
    cx.rec('103.pay', 'LoanPay 2000 MPT', '', await submit(cx.client, {
      TransactionType: 'LoanPay', Account: BW.classicAddress, LoanID: LID2, Amount: '2000',
    }, BW))
  }
}

await cx.done()
