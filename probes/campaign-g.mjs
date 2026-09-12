// Campagne G — défaut, impairment, et qui encaisse la perte.
// Trois brokers sur le même vault :
//   B1 cover 5 XRP  → défaut contrôlé, perte < cover        (81-85, 88, 90)
//   B2 cover 0      → défaut à cover nul                     (86, 89)
//   B3 cover 1 XRP  → perte > cover, reliquat sur déposants  (87)
// Puis Redemption avec un prêt encore vivant (91).
import {
  startCampaign, vaultCreate, depositTx, withdrawTx,
  submit, submitLoanSet, createdIndex, rippleNow, sleep, XRP,
  MANAGE_FLAGS, shareBalance,
} from './_lib.mjs'

const cx = await startCampaign('g')
const { O, D, BW, BW2 } = await cx.fundMany(['O', 'D', 'BW', 'BW2'])

const sub = rippleNow() + 90
const red = sub + 780
const V = await vaultCreate(cx.client, O, {
  Asset: { currency: 'XRP' }, AssetsMaximum: '0', VaultKind: 1,
  SubscriptionDate: sub, RedemptionDate: red, WithdrawalPolicy: 1,
})
cx.rec('G0', 'VaultCreate', 'closed, investment 780s', V)
cx.rec('G0.dep', 'D dépose 50 XRP', 'VaultDeposit', await submit(cx.client, depositTx(D, V.vaultId, XRP(50)), D))
cx.saveState({ V: V.vaultId, mptId: V.mptId, sub, red })

async function snap(tag) {
  const v = await cx.request({ command: 'vault_info', vault_id: V.vaultId }).then(r => r.vault)
  const out = BigInt(v.shares?.OutstandingAmount ?? 0)
  const nav = out > 0n ? Number(BigInt(v.AssetsTotal) * 1_000_000n / out) / 1e6 : NaN
  cx.note(tag, `vault: AssetsTotal=${v.AssetsTotal} AssetsAvailable=${v.AssetsAvailable} LossUnrealized=${v.LossUnrealized ?? '0'} parts=${out} NAV/part=${nav}`)
  return v
}
async function snapBroker(bid, tag) {
  try {
    const b = await cx.entry(bid)
    cx.note(tag, `broker ${bid.slice(0, 8)}: CoverAvailable=${b.CoverAvailable ?? '0'} DebtTotal=${b.DebtTotal ?? '0'}`)
    return b
  } catch { cx.note(tag, `broker ${bid.slice(0, 8)}: objet SUPPRIMÉ`); return null }
}
async function snapLoan(lid, tag) {
  try {
    const l = await cx.entry(lid)
    cx.note(tag, `loan ${lid.slice(0, 8)}: PrincipalOut=${l.PrincipalOutstanding} TVO=${l.TotalValueOutstanding} Next=${l.NextPaymentDueDate} PayRemaining=${l.PaymentRemaining} Flags=${l.Flags ?? 0}`)
    return l
  } catch { cx.note(tag, `loan ${lid.slice(0, 8)}: objet SUPPRIMÉ`); return null }
}

// ── brokers (en Subscription si permis, sinon après) — B saura ; ici on tente direct
async function mkBroker(id, { coverMin, coverLiq, cover }) {
  const r = await submit(cx.client, {
    TransactionType: 'LoanBrokerSet', Account: O.classicAddress, VaultID: V.vaultId,
    DebtMaximum: '0', CoverRateMinimum: coverMin, CoverRateLiquidation: coverLiq, ManagementFeeRate: 0,
  }, O)
  const bid = createdIndex(r, 'LoanBroker')
  cx.rec(id, `LoanBrokerSet rates ${coverMin}/${coverLiq}`, 'LoanBrokerSet', r)
  if (bid && cover > 0) {
    const cd = await submit(cx.client, {
      TransactionType: 'LoanBrokerCoverDeposit', Account: O.classicAddress, LoanBrokerID: bid, Amount: XRP(cover),
    }, O)
    cx.rec(`${id}.cover`, `CoverDeposit ${cover} XRP`, 'LoanBrokerCoverDeposit', cd)
  }
  return bid
}

{
  const wait = sub - rippleNow() + 6
  if (wait > 0) { cx.log(`attente Investment (${wait}s)…`); await sleep(wait * 1000) }
}

const B1 = await mkBroker('G.B1', { coverMin: 10000, coverLiq: 50000, cover: 5 })
const B2 = await mkBroker('G.B2', { coverMin: 0, coverLiq: 0, cover: 0 })
const B3 = await mkBroker('G.B3', { coverMin: 10000, coverLiq: 50000, cover: 1 })
cx.saveState({ B1, B2, B3 })

// ── prêts : L1 (B1, 4 XRP), L2 (B2, 6 XRP), L3 (B3, 8 XRP), L4 (B2, 5 XRP, ignoré jusqu'en Redemption)
async function mkLoan(id, borrower, bid, xrp, { interval = 60, total = 2, grace = 30 } = {}) {
  const r = await submitLoanSet(cx.client, {
    TransactionType: 'LoanSet', Account: borrower.classicAddress, LoanBrokerID: bid,
    PrincipalRequested: XRP(xrp), PaymentInterval: interval, PaymentTotal: total,
    GracePeriod: grace, InterestRate: 50000,
  }, borrower, O)
  cx.rec(id, `LoanSet ${xrp} XRP (broker ${bid?.slice(0, 8)})`, `interval ${interval}s total ${total} grace ${grace}s`, r)
  return createdIndex(r, 'Loan')
}
const t0 = rippleNow()
const L1 = await mkLoan('G.L1', BW, B1, 4)
const L2 = await mkLoan('G.L2', BW2, B2, 6)
const L3 = await mkLoan('G.L3', BW, B3, 8)
const L4 = await mkLoan('G.L4', BW2, B2, 5, { interval: 300, total: 2, grace: 60 })
cx.saveState({ L1, L2, L3, L4 })
await snap('G.après-prêts')

// ── 81 : impair AVANT échéance (échéance ≈ t0+60)
cx.rec('81', 'tfLoanImpair avant échéance', `now-due=${rippleNow() - (t0 + 60)}s`, await submit(cx.client, {
  TransactionType: 'LoanManage', Account: O.classicAddress, LoanID: L1, Flags: MANAGE_FLAGS.IMPAIR,
}, O))
let l1 = await snapLoan(L1, '81')
await snap('81')

// si l'impair précoce a réussi, on remet à zéro pour la suite
{
  const l = await cx.entry(L1).catch(() => null)
  if (l && (Number(l.Flags ?? 0) & 0x00020000)) {
    cx.rec('81.undo', 'tfLoanUnimpair (retour arrière)', '', await submit(cx.client, {
      TransactionType: 'LoanManage', Account: O.classicAddress, LoanID: L1, Flags: MANAGE_FLAGS.UNIMPAIR,
    }, O))
  }
}

// ── 82 : impair PENDANT le délai de grâce (due=t0+60, grace 30 → viser due+10)
{
  const due = Number(l1?.NextPaymentDueDate ?? (t0 + 60))
  const wait = due + 10 - rippleNow()
  if (wait > 0) { cx.log(`attente milieu de grâce (${wait}s)…`); await sleep(wait * 1000) }
}
cx.rec('82', 'tfLoanImpair pendant la grâce', '', await submit(cx.client, {
  TransactionType: 'LoanManage', Account: O.classicAddress, LoanID: L1, Flags: MANAGE_FLAGS.IMPAIR,
}, O))
{
  const l = await cx.entry(L1).catch(() => null)
  if (l && (Number(l.Flags ?? 0) & 0x00020000)) {
    cx.rec('82.undo', 'tfLoanUnimpair (retour arrière)', '', await submit(cx.client, {
      TransactionType: 'LoanManage', Account: O.classicAddress, LoanID: L1, Flags: MANAGE_FLAGS.UNIMPAIR,
    }, O))
  }
}

// ── 83 : impair APRÈS échéance + grâce
{
  const l = await cx.entry(L1).catch(() => null)
  const due = Number(l?.NextPaymentDueDate ?? (t0 + 60))
  const grace = Number(l?.GracePeriod ?? 30)
  const wait = due + grace + 8 - rippleNow()
  if (wait > 0) { cx.log(`attente due+grace (${wait}s)…`); await sleep(wait * 1000) }
}
await snap('83.avant')
cx.rec('83', 'tfLoanImpair après échéance+grâce', '', await submit(cx.client, {
  TransactionType: 'LoanManage', Account: O.classicAddress, LoanID: L1, Flags: MANAGE_FLAGS.IMPAIR,
}, O))
await snap('83.après')
await snapLoan(L1, '83')

// ── 90 : l'emprunteur paie un prêt impairé
cx.rec('90', 'LoanPay sur prêt impairé', 'LoanPay 2.5 XRP', await submit(cx.client, {
  TransactionType: 'LoanPay', Account: BW.classicAddress, LoanID: L1, Amount: XRP(2.5),
}, BW))
await snapLoan(L1, '90')
await snap('90')

// ── 84 : unimpair — tout revient-il ?
cx.rec('84', 'tfLoanUnimpair', '', await submit(cx.client, {
  TransactionType: 'LoanManage', Account: O.classicAddress, LoanID: L1, Flags: MANAGE_FLAGS.UNIMPAIR,
}, O))
await snap('84')
await snapLoan(L1, '84')

// ── 85 : DÉFAUT contrôlé sur L1 (cover 5 XRP > perte) — suivre l'argent
{
  const l = await cx.entry(L1).catch(() => null)
  if (l) {
    const due = Number(l.NextPaymentDueDate)
    const wait = due + Number(l.GracePeriod ?? 30) + 8 - rippleNow()
    if (wait > 0) { cx.log(`attente défaillabilité L1 (${wait}s)…`); await sleep(wait * 1000) }
  }
}
await snap('85.avant'); await snapBroker(B1, '85.avant'); await snapLoan(L1, '85.avant')
const oBal0 = await cx.request({ command: 'account_info', account: O.classicAddress, ledger_index: 'validated' }).then(r => r.account_data.Balance)
cx.rec('85', 'tfLoanDefault L1 (perte < cover)', '', await submit(cx.client, {
  TransactionType: 'LoanManage', Account: O.classicAddress, LoanID: L1, Flags: MANAGE_FLAGS.DEFAULT,
}, O))
await snap('85.après'); await snapBroker(B1, '85.après'); await snapLoan(L1, '85.après')
const oBal1 = await cx.request({ command: 'account_info', account: O.classicAddress, ledger_index: 'validated' }).then(r => r.account_data.Balance)
cx.note('85', `solde O (broker owner): ${oBal0} → ${oBal1} (delta ${BigInt(oBal1) - BigInt(oBal0)} drops)`)

// ── 86 : défaut à cover NUL sur L2 — les déposants absorbent-ils tout ?
{
  const l = await cx.entry(L2).catch(() => null)
  if (l) {
    const wait = Number(l.NextPaymentDueDate) + Number(l.GracePeriod ?? 30) + 8 - rippleNow()
    if (wait > 0) { cx.log(`attente défaillabilité L2 (${wait}s)…`); await sleep(wait * 1000) }
  }
}
await snap('86.avant'); await snapBroker(B2, '86.avant')
cx.rec('86', 'tfLoanDefault L2 (cover = 0)', '', await submit(cx.client, {
  TransactionType: 'LoanManage', Account: O.classicAddress, LoanID: L2, Flags: MANAGE_FLAGS.DEFAULT,
}, O))
await snap('86.après'); await snapBroker(B2, '86.après')

// ── 87 : perte (8 XRP) > cover (1 XRP) sur L3
await snap('87.avant'); await snapBroker(B3, '87.avant')
cx.rec('87', 'tfLoanDefault L3 (perte > cover)', '', await submit(cx.client, {
  TransactionType: 'LoanManage', Account: O.classicAddress, LoanID: L3, Flags: MANAGE_FLAGS.DEFAULT,
}, O))
await snap('87.après'); await snapBroker(B3, '87.après')

// ── 88 : que reste-t-il de L1 après défaut ?
await snapLoan(L1, '88')
{
  const txs = await cx.request({
    command: 'account_tx', account: V.vault?.Account ?? (await cx.request({ command: 'vault_info', vault_id: V.vaultId })).vault.Account,
    ledger_index_min: -1, ledger_index_max: -1, limit: 100,
  }).catch(() => null)
  const manages = (txs?.transactions ?? []).filter(t => (t.tx_json ?? t.tx)?.TransactionType === 'LoanManage')
  cx.note('88', `account_tx du pseudo-compte vault : ${manages.length} LoanManage visibles`)
}

// ── 89 : L4 laissé à l'abandon (due=t0+300, grace 60) — personne ne force rien ?
{
  const l = await cx.entry(L4).catch(() => null)
  if (l) {
    const wait = Number(l.NextPaymentDueDate) + Number(l.GracePeriod ?? 60) + 20 - rippleNow()
    if (wait > 0) { cx.log(`attente : L4 dépasse échéance+grâce sans que personne n'agisse (${wait}s)…`); await sleep(wait * 1000) }
    const after = await cx.entry(L4).catch(() => null)
    const same = after && JSON.stringify(after) === JSON.stringify(l)
    cx.rec('89', 'prêt défaillable NON déclaré : objet inchangé ?', 'observation passive',
      same ? 'objet strictement inchangé' : 'OBJET A CHANGÉ', same ? 'attendu' : 'surprenant',
      `Flags=${after?.Flags ?? '?'} LossUnrealized vault=${(await cx.request({ command: 'vault_info', vault_id: V.vaultId })).vault.LossUnrealized ?? '0'}`)
  }
}

// ── 91 : Redemption avec L4 encore vivant — les déposants sortent-ils ?
{
  const wait = red - rippleNow() + 6
  if (wait > 0) { cx.log(`attente Redemption (${wait}s)…`); await sleep(wait * 1000) }
}
const vR = await snap('91.avant')
const sb = await shareBalance(cx.client, D.classicAddress, V.mptId)
cx.note('91', `D détient ${sb.amount} parts ; AssetsAvailable=${vR.AssetsAvailable}`)
cx.rec('91.full', 'retrait TOTAL en Redemption avec prêt vivant', `VaultWithdraw ${sb.amount} parts`,
  await submit(cx.client, withdrawTx(D, V.vaultId, V.mptId, sb.amount), D))
// si refusé : jusqu'où peut-on aller ? on tente pile AssetsAvailable en parts (NAV≈?)
const vR2 = await cx.request({ command: 'vault_info', vault_id: V.vaultId }).then(r => r.vault)
const sb2 = await shareBalance(cx.client, D.classicAddress, V.mptId)
if (sb2.amount > 0n) {
  const avail = BigInt(vR2.AssetsAvailable)
  const total = BigInt(vR2.AssetsTotal)
  const out = BigInt(vR2.shares.OutstandingAmount)
  const sharesForAvail = avail * out / total          // parts ≈ valeur disponible
  cx.rec('91.avail', `retrait calé sur AssetsAvailable (${avail} drops ≈ ${sharesForAvail} parts)`, 'VaultWithdraw',
    await submit(cx.client, withdrawTx(D, V.vaultId, V.mptId, sharesForAvail), D))
  await snap('91.après')
}

await cx.done()
