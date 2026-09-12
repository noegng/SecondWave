// I2 — contre-essais de la campagne I :
//  a. où a atterri le principal des prêts accordés SANS trustline (M) / SANS MPToken (BW) ?
//  b. gel global : refaire les tests avec les bons types d'Amount, sur vault open-ended
//  c. LoanPay IOU avec le bon Amount (le premier essai passait des drops → tecWRONG_ASSET)
import fs from 'node:fs'
import { startCampaign, vaultCreate, depositTx, withdrawTx, submit, XRP, Wallet, shareBalance } from './_lib.mjs'

const st = JSON.parse(fs.readFileSync(new URL('./state-i.json', import.meta.url), 'utf8'))
const cx = await startCampaign('i2')
const [IS, O, D, BW, M] = ['IS', 'O', 'D', 'BW', 'M'].map(k => Wallet.fromSeed(st.wallets[k].seed))
const iou = v => ({ currency: 'USD', issuer: IS.classicAddress, value: String(v) })

// ── a. le prêt sans trustline : M a-t-il reçu 10 USD ? comment ?
{
  const lines = (await cx.request({ command: 'account_lines', account: M.classicAddress, ledger_index: 'validated' })).lines
  cx.rec('a.M', 'trustlines de M après le prêt de 10 USD sans trustline', 'account_lines',
    lines.length ? JSON.stringify(lines.map(l => ({ cur: l.currency, bal: l.balance, limit: l.limit }))) : 'AUCUNE trustline',
    lines.length ? 'surprenant' : 'bug probable')
  const objs = (await cx.request({ command: 'account_objects', account: M.classicAddress, ledger_index: 'validated' })).account_objects
  cx.note('a.M', `objets de M: ${objs.map(o => o.LedgerEntryType).join(',') || '(aucun)'}`)
}
{
  const objs = (await cx.request({ command: 'account_objects', account: BW.classicAddress, type: 'mptoken', ledger_index: 'validated' })).account_objects
  cx.rec('a.BW', 'MPToken de BW après les prêts MPT (dont un sans MPToken préalable)', 'account_objects',
    JSON.stringify(objs.map(o => ({ id: o.MPTokenIssuanceID?.slice(-8), amount: o.MPTAmount ?? '0' }))))
}

// ── b. gel global proprement : vault IOU OPEN-ENDED (dépôt/retrait libres)
const V = await vaultCreate(cx.client, O, {
  Asset: { currency: 'USD', issuer: IS.classicAddress }, AssetsMaximum: '0', WithdrawalPolicy: 1, Scale: 6,
})
cx.rec('b.0', 'vault IOU open-ended (pour isoler le gel)', '', V)
cx.rec('b.dep0', 'D dépose 50 USD (avant gel)', '', await submit(cx.client, depositTx(D, V.vaultId, iou('50')), D))
cx.rec('b.freeze', 'asfGlobalFreeze', '', await submit(cx.client, { TransactionType: 'AccountSet', Account: IS.classicAddress, SetFlag: 7 }, IS))
cx.rec('b.dep', 'dépôt 10 USD SOUS GEL', '', await submit(cx.client, depositTx(D, V.vaultId, iou('10')), D))
cx.rec('b.wd', 'retrait 10e6 parts SOUS GEL', '', await submit(cx.client, withdrawTx(D, V.vaultId, V.mptId, 10_000_000), D))
// et un LoanPay IOU bien formé sous gel, si le prêt de la campagne I vit encore
if (st.V && st.BID) {
  const loans = (await cx.request({ command: 'account_objects', account: (await cx.entry(st.BID)).Account, type: 'loan', ledger_index: 'validated' }).catch(() => ({ account_objects: [] }))).account_objects
  const lid = loans[0]?.index
  if (lid) {
    cx.rec('b.lpay', 'LoanPay 20 USD (bien typé) SOUS GEL', '', await submit(cx.client, {
      TransactionType: 'LoanPay', Account: BW.classicAddress, LoanID: lid, Amount: iou('20'),
    }, BW))
  } else cx.note('b.lpay', 'plus de prêt vivant sur le broker IOU')
}
cx.rec('b.unfreeze', 'levée du gel', '', await submit(cx.client, { TransactionType: 'AccountSet', Account: IS.classicAddress, ClearFlag: 7 }, IS))
cx.rec('b.wd2', 'retrait 10e6 parts APRÈS dégel (contrôle)', '', await submit(cx.client, withdrawTx(D, V.vaultId, V.mptId, 10_000_000), D))

// ── c. LoanPay IOU bien typé hors gel (si un prêt vit encore)
if (st.V && st.BID) {
  const loans = (await cx.request({ command: 'account_objects', account: (await cx.entry(st.BID)).Account, type: 'loan', ledger_index: 'validated' }).catch(() => ({ account_objects: [] }))).account_objects
  for (const l of loans) {
    cx.note('c', `prêt ${l.index.slice(0, 8)}: borrower=${l.Borrower?.slice(0, 8)} PrincipalOut=${l.PrincipalOutstanding} Next=${l.NextPaymentDueDate}`)
  }
  const mine = loans.find(l => l.Borrower === BW.classicAddress)
  if (mine) {
    cx.rec('c.pay', 'LoanPay 55 USD bien typé (IOU)', '', await submit(cx.client, {
      TransactionType: 'LoanPay', Account: BW.classicAddress, LoanID: mine.index, Amount: iou('55'), Flags: 262144,
    }, BW))
  }
}

await cx.done()
