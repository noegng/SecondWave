// Campagne G (v2) — défaut, impairment, qui encaisse la perte.
// Réutilise les wallets de state-g.json ; crée un vault neuf (le premier a
// grillé sa fenêtre pendant le diagnostic du temINVALID GracePeriod).
// Contrainte découverte : 60 ≤ GracePeriod ≤ PaymentInterval.
import fs from 'node:fs'
import {
  startCampaign, vaultCreate, depositTx, withdrawTx,
  submit, submitLoanSet, createdIndex, rippleNow, sleep, XRP,
  MANAGE_FLAGS, shareBalance, Wallet,
} from './_lib.mjs'

const old = JSON.parse(fs.readFileSync(new URL('./state-g.json', import.meta.url), 'utf8'))
const cx = await startCampaign('g2')
const O = Wallet.fromSeed(old.wallets.O.seed)
const D = Wallet.fromSeed(old.wallets.D.seed)
const BW = Wallet.fromSeed(old.wallets.BW.seed)
const BW2 = Wallet.fromSeed(old.wallets.BW2.seed)
cx.log('wallets repris de state-g.json')

const sub = rippleNow() + 70
const red = sub + 610
const V = await vaultCreate(cx.client, O, {
  Asset: { currency: 'XRP' }, AssetsMaximum: '0', VaultKind: 1,
  SubscriptionDate: sub, RedemptionDate: red, WithdrawalPolicy: 1,
})
cx.rec('G0', 'VaultCreate (v2)', 'investment 610s', V)
cx.rec('G0.dep', 'D dépose 30 XRP', '', await submit(cx.client, depositTx(D, V.vaultId, XRP(30)), D))
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
  if (!lid) { cx.note(tag, 'loan: (jamais créé)'); return null }
  try {
    const l = await cx.entry(lid)
    cx.note(tag, `loan ${lid.slice(0, 8)}: PrincipalOut=${l.PrincipalOutstanding} TVO=${l.TotalValueOutstanding} Next=${l.NextPaymentDueDate} PayRemaining=${l.PaymentRemaining} Flags=${l.Flags ?? 0}`)
    return l
  } catch { cx.note(tag, `loan ${lid.slice(0, 8)}: objet SUPPRIMÉ`); return null }
}
const manage = (lid, flag) => submit(cx.client, {
  TransactionType: 'LoanManage', Account: O.classicAddress, LoanID: lid, Flags: flag,
}, O)

// brokers créés PENDANT la Subscription (B a montré que c'est permis)
async function mkBroker(id, { coverMin, coverLiq, cover }) {
  const r = await submit(cx.client, {
    TransactionType: 'LoanBrokerSet', Account: O.classicAddress, VaultID: V.vaultId,
    DebtMaximum: '0', CoverRateMinimum: coverMin, CoverRateLiquidation: coverLiq, ManagementFeeRate: 0,
  }, O)
  const bid = createdIndex(r, 'LoanBroker')
  cx.rec(id, `LoanBrokerSet rates ${coverMin}/${coverLiq} (en Subscription)`, '', r)
  if (bid && cover > 0) {
    cx.rec(`${id}.cover`, `CoverDeposit ${cover} XRP`, '', await submit(cx.client, {
      TransactionType: 'LoanBrokerCoverDeposit', Account: O.classicAddress, LoanBrokerID: bid, Amount: XRP(cover),
    }, O))
  }
  return bid
}
const B1 = await mkBroker('G.B1', { coverMin: 10000, coverLiq: 50000, cover: 5 })
const B2 = await mkBroker('G.B2', { coverMin: 0, coverLiq: 0, cover: 0 })
const B3 = await mkBroker('G.B3', { coverMin: 10000, coverLiq: 50000, cover: 1 })
cx.saveState({ B1, B2, B3 })

{
  const wait = sub - rippleNow() + 6
  if (wait > 0) { cx.log(`attente Investment (${wait}s)…`); await sleep(wait * 1000) }
}

async function mkLoan(id, borrower, bid, xrp, { interval = 60, total = 2, grace = 60 } = {}) {
  const r = await submitLoanSet(cx.client, {
    TransactionType: 'LoanSet', Account: borrower.classicAddress, LoanBrokerID: bid,
    PrincipalRequested: XRP(xrp), PaymentInterval: interval, PaymentTotal: total,
    GracePeriod: grace, InterestRate: 50000,
  }, borrower, O)
  cx.rec(id, `LoanSet ${xrp} XRP`, `interval ${interval} total ${total} grace ${grace}`, r)
  return createdIndex(r, 'Loan')
}
const t0 = rippleNow()
const L1 = await mkLoan('G.L1', BW, B1, 4)
const L2 = await mkLoan('G.L2', BW2, B2, 6)
const L3 = await mkLoan('G.L3', BW, B3, 8)
cx.saveState({ L1, L2, L3 })
await snap('G.après-prêts')

// ── 81 : impair AVANT échéance (due ≈ t0+60)
cx.rec('81', `tfLoanImpair avant échéance (now-due=${rippleNow() - (t0 + 60)}s)`, '', await manage(L1, MANAGE_FLAGS.IMPAIR))
let l1 = await snapLoan(L1, '81'); await snap('81')
if (l1 && (Number(l1.Flags ?? 0) & 0x00020000))
  cx.rec('81.undo', 'tfLoanUnimpair (retour arrière)', '', await manage(L1, MANAGE_FLAGS.UNIMPAIR))

// ── 82 : impair PENDANT la grâce (due+15)
{
  const due = Number(l1?.NextPaymentDueDate ?? (t0 + 60))
  const wait = due + 15 - rippleNow()
  if (wait > 0) { cx.log(`attente milieu de grâce (${wait}s)…`); await sleep(wait * 1000) }
}
cx.rec('82', 'tfLoanImpair pendant la grâce', '', await manage(L1, MANAGE_FLAGS.IMPAIR))
{
  const l = await cx.entry(L1).catch(() => null)
  if (l && (Number(l.Flags ?? 0) & 0x00020000))
    cx.rec('82.undo', 'tfLoanUnimpair (retour arrière)', '', await manage(L1, MANAGE_FLAGS.UNIMPAIR))
}

// ── 83 : impair APRÈS échéance + grâce
{
  const l = await cx.entry(L1).catch(() => null)
  const wait = Number(l?.NextPaymentDueDate ?? (t0 + 60)) + Number(l?.GracePeriod ?? 60) + 8 - rippleNow()
  if (wait > 0) { cx.log(`attente due+grace (${wait}s)…`); await sleep(wait * 1000) }
}
await snap('83.avant')
cx.rec('83', 'tfLoanImpair après échéance+grâce', '', await manage(L1, MANAGE_FLAGS.IMPAIR))
await snap('83.après'); await snapLoan(L1, '83')

// ── 90 : l'emprunteur paie un prêt impairé
cx.rec('90', 'LoanPay 2.5 XRP sur prêt IMPAIRÉ', '', await submit(cx.client, {
  TransactionType: 'LoanPay', Account: BW.classicAddress, LoanID: L1, Amount: XRP(2.5),
}, BW))
await snapLoan(L1, '90'); await snap('90')

// ── 84 : unimpair — réversible ?
cx.rec('84', 'tfLoanUnimpair', '', await manage(L1, MANAGE_FLAGS.UNIMPAIR))
await snap('84'); await snapLoan(L1, '84')

// ── 86 : défaut à cover NUL (L2 défaillable depuis t0+120)
{
  const l = await cx.entry(L2).catch(() => null)
  const wait = l ? Number(l.NextPaymentDueDate) + Number(l.GracePeriod ?? 60) + 8 - rippleNow() : 0
  if (wait > 0) { cx.log(`attente défaillabilité L2 (${wait}s)…`); await sleep(wait * 1000) }
}
await snap('86.avant'); await snapBroker(B2, '86.avant')
cx.rec('86', 'tfLoanDefault L2 (cover = 0)', '', await manage(L2, MANAGE_FLAGS.DEFAULT))
await snap('86.après'); await snapBroker(B2, '86.après'); await snapLoan(L2, '86')

// ── 87 : perte (8 XRP) > cover (1 XRP)
await snap('87.avant'); await snapBroker(B3, '87.avant')
cx.rec('87', 'tfLoanDefault L3 (perte > cover)', '', await manage(L3, MANAGE_FLAGS.DEFAULT))
await snap('87.après'); await snapBroker(B3, '87.après'); await snapLoan(L3, '87')

// ── 85 : défaut contrôlé L1 (cover 5 > perte ~1.7) — suivre l'argent
{
  const l = await cx.entry(L1).catch(() => null)
  const wait = l ? Number(l.NextPaymentDueDate) + Number(l.GracePeriod ?? 60) + 8 - rippleNow() : 0
  if (wait > 0) { cx.log(`attente défaillabilité L1 (${wait}s)…`); await sleep(wait * 1000) }
}
await snap('85.avant'); await snapBroker(B1, '85.avant'); await snapLoan(L1, '85.avant')
const oBal0 = BigInt((await cx.request({ command: 'account_info', account: O.classicAddress, ledger_index: 'validated' })).account_data.Balance)
cx.rec('85', 'tfLoanDefault L1 (perte < cover)', '', await manage(L1, MANAGE_FLAGS.DEFAULT))
await snap('85.après'); await snapBroker(B1, '85.après'); await snapLoan(L1, '85.après')
const oBal1 = BigInt((await cx.request({ command: 'account_info', account: O.classicAddress, ledger_index: 'validated' })).account_data.Balance)
cx.note('85', `solde O (broker owner): delta ${oBal1 - oBal0} drops`)

// ── 88 : traces après défaut
await snapLoan(L1, '88')
{
  const vAcct = (await cx.request({ command: 'vault_info', vault_id: V.vaultId })).vault.Account
  const txs = await cx.request({
    command: 'account_tx', account: vAcct, ledger_index_min: -1, ledger_index_max: -1, limit: 100,
  }).catch(() => null)
  const types = {}
  for (const t of txs?.transactions ?? []) {
    const ty = (t.tx_json ?? t.tx)?.TransactionType ?? '?'
    types[ty] = (types[ty] ?? 0) + 1
  }
  cx.note('88', `account_tx pseudo-compte vault: ${JSON.stringify(types)}`)
}

// ── 89 : le prêt à l'abandon (L4 du run 1, vault d'origine)
if (old.L4) {
  const l4 = await cx.entry(old.L4).catch(() => null)
  const vOld = await cx.request({ command: 'vault_info', vault_id: old.V }).then(r => r.vault).catch(() => null)
  if (l4 && vOld) {
    const late = rippleNow() - (Number(l4.NextPaymentDueDate) + Number(l4.GracePeriod ?? 0))
    cx.rec('89', `prêt défaillable non déclaré depuis ${late}s`, 'observation L4 (run 1)',
      `Flags=${l4.Flags ?? 0}, LossUnrealized vault=${vOld.LossUnrealized ?? '0'}`,
      late > 0 ? 'rien ne force le broker' : 'pas encore défaillable',
      `PrincipalOut=${l4.PrincipalOutstanding} Next=${l4.NextPaymentDueDate}`)
  } else cx.note('89', `L4 introuvable (l4=${!!l4} vault=${!!vOld})`)
}

// ── 91 : Redemption avec prêt vivant — le vault d'ORIGINE (red dépassé, L4 dedans)
{
  const vOld = await cx.request({ command: 'vault_info', vault_id: old.V }).then(r => r.vault).catch(() => null)
  if (vOld) {
    const wait = Number(vOld.RedemptionDate) - rippleNow() + 6
    if (wait > 0) { cx.log(`attente Redemption vault d'origine (${wait}s)…`); await sleep(wait * 1000) }
    const sb = await shareBalance(cx.client, D.classicAddress, old.mptId)
    cx.note('91', `vault origine: AssetsTotal=${vOld.AssetsTotal} AssetsAvailable=${vOld.AssetsAvailable} | D détient ${sb.amount} parts`)
    cx.rec('91.full', 'retrait TOTAL en Redemption, prêt L4 vivant (5 XRP dehors)', `VaultWithdraw ${sb.amount} parts`,
      await submit(cx.client, withdrawTx(D, old.V, old.mptId, sb.amount), D))
    const v2 = await cx.request({ command: 'vault_info', vault_id: old.V }).then(r => r.vault)
    const sb2 = await shareBalance(cx.client, D.classicAddress, old.mptId)
    if (sb2.amount > 0n) {
      const avail = BigInt(v2.AssetsAvailable)
      const out = BigInt(v2.shares.OutstandingAmount)
      const total = BigInt(v2.AssetsTotal)
      const sharesForAvail = avail * out / total
      cx.rec('91.avail', `retrait calé sur AssetsAvailable (${avail} drops ≈ ${sharesForAvail} parts)`, '',
        await submit(cx.client, withdrawTx(D, old.V, old.mptId, sharesForAvail), D))
      const v3 = await cx.request({ command: 'vault_info', vault_id: old.V }).then(r => r.vault)
      cx.note('91', `après: AssetsTotal=${v3.AssetsTotal} AssetsAvailable=${v3.AssetsAvailable} parts D=${(await shareBalance(cx.client, D.classicAddress, old.mptId)).amount}`)
    }
  }
}

await cx.done()
