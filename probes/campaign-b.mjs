// Campagne B — les phases d'un vault closed-ended, transaction par transaction.
// Pièce maîtresse : la matrice 7 tx × 3 phases (cas 21), plus VaultSet sur les
// dates (26), VaultDelete (27), open-ended (25).
import {
  startCampaign, vaultCreate, depositTx, withdrawTx,
  submit, submitLoanSet, createdIndex, rippleNow, sleep, XRP, hex,
} from './_lib.mjs'

const cx = await startCampaign('b')
const { O, D, BW } = await cx.fundMany(['O', 'D', 'BW'])

// ── Décor : V1 (le vault de la matrice) + trois vaults vides pour VaultDelete
const sub = rippleNow() + 200
const red = sub + 420
cx.note('B0', `sub=${sub} red=${red} (subscription ${sub - rippleNow()}s, investment 420s)`)

const V1 = await vaultCreate(cx.client, O, {
  Asset: { currency: 'XRP' }, AssetsMaximum: '0', VaultKind: 1,
  SubscriptionDate: sub, RedemptionDate: red, WithdrawalPolicy: 1, Data: hex('v1'),
})
cx.rec('B0', 'VaultCreate V1 closed-ended', 'VaultCreate VaultKind:1', V1)
const empties = {}
for (const k of ['S', 'I', 'R']) {
  const v = await vaultCreate(cx.client, O, {
    Asset: { currency: 'XRP' }, AssetsMaximum: '0', VaultKind: 1,
    SubscriptionDate: sub, RedemptionDate: red, WithdrawalPolicy: 1,
  })
  empties[k] = v.vaultId
}
cx.note('B0', `vaults vides pour VaultDelete: ${Object.values(empties).map(v => v?.slice(0, 8)).join(' ')}`)
cx.saveState({ V1: V1.vaultId, mptId: V1.mptId, empties, sub, red })

let BID = null   // broker sur V1, créé dès que la phase le permet
let LID = null   // prêt sur V1

// ── Les 7 transactions de la matrice, paramétrées par phase
async function matrix(phase) {
  cx.log(`\n=== MATRICE phase ${phase} (now-sub=${rippleNow() - sub}s, now-red=${rippleNow() - red}s) ===`)
  const dep = await submit(cx.client, depositTx(D, V1.vaultId, XRP(10)), D)
  cx.rec(`21.dep.${phase}`, `VaultDeposit en ${phase}`, 'VaultDeposit 10 XRP par D', dep)

  const wd = await submit(cx.client, withdrawTx(D, V1.vaultId, V1.mptId, 1_000_000), D)
  cx.rec(`21.wd.${phase}`, `VaultWithdraw en ${phase}`, 'VaultWithdraw 1e6 parts par D', wd)

  const vset = await submit(cx.client, {
    TransactionType: 'VaultSet', Account: O.classicAddress, VaultID: V1.vaultId, Data: hex('maj-' + phase),
  }, O)
  cx.rec(`21.set.${phase}`, `VaultSet (Data) en ${phase}`, 'VaultSet Data', vset)

  const vdel = await submit(cx.client, {
    TransactionType: 'VaultDelete', Account: O.classicAddress, VaultID: empties[phase[0]],
  }, O)
  cx.rec(`21.del.${phase}`, `VaultDelete (vault vide) en ${phase}`, 'VaultDelete vault vide', vdel)

  const bset = await submit(cx.client, {
    TransactionType: 'LoanBrokerSet', Account: O.classicAddress, VaultID: V1.vaultId,
    DebtMaximum: '0', CoverRateMinimum: 0, CoverRateLiquidation: 0, ManagementFeeRate: 0,
  }, O)
  cx.rec(`21.bset.${phase}`, `LoanBrokerSet en ${phase}`, 'LoanBrokerSet rates 0/0', bset)
  const newBid = createdIndex(bset, 'LoanBroker')
  if (newBid && !BID) BID = newBid

  if (BID) {
    // fin du prêt calée pour être légale en Investment : interval court, total 1
    const ls = await submitLoanSet(cx.client, {
      TransactionType: 'LoanSet', Account: BW.classicAddress, LoanBrokerID: BID,
      PrincipalRequested: XRP(3), PaymentInterval: 60, PaymentTotal: 2,
      GracePeriod: 30, InterestRate: 50000,
    }, BW, O)
    cx.rec(`21.lset.${phase}`, `LoanSet en ${phase}`, 'LoanSet 3 XRP interval 60 total 2', ls)
    const newLid = createdIndex(ls, 'Loan')
    if (newLid && !LID) LID = newLid
  } else {
    cx.rec(`21.lset.${phase}`, `LoanSet en ${phase}`, 'LoanSet', 'n/a', 'structurel',
      'aucun broker ne peut exister dans cette phase')
  }

  if (LID) {
    const lp = await submit(cx.client, {
      TransactionType: 'LoanPay', Account: BW.classicAddress, LoanID: LID, Amount: XRP(1),
    }, BW)
    cx.rec(`21.lpay.${phase}`, `LoanPay en ${phase}`, 'LoanPay 1 XRP', lp)
  } else {
    cx.rec(`21.lpay.${phase}`, `LoanPay en ${phase}`, 'LoanPay', 'n/a', 'structurel',
      'aucun prêt ne peut exister dans cette phase')
  }
}

// ── 26 : VaultSet peut-il déplacer les dates ?
async function moveDates(phase) {
  for (const [field, delta, label] of [
    ['SubscriptionDate', +300, 'repousser SubscriptionDate'],
    ['SubscriptionDate', -60, 'avancer SubscriptionDate'],
    ['RedemptionDate', +600, 'repousser RedemptionDate (enfermement !)'],
    ['RedemptionDate', -60, 'avancer RedemptionDate'],
  ]) {
    const base = field === 'SubscriptionDate' ? sub : red
    const r = await submit(cx.client, {
      TransactionType: 'VaultSet', Account: O.classicAddress, VaultID: V1.vaultId,
      [field]: base + delta,
    }, O)
    cx.rec(`26.${field[0]}${delta > 0 ? '+' : '-'}.${phase}`, `VaultSet ${label} en ${phase}`, `VaultSet ${field}=${base + delta}`, r)
  }
}

// ══ PHASE SUBSCRIPTION ══
await matrix('Subscription')
await moveDates('Subscription')

// ── 25 : un vault open-ended, pendant qu'on attend la phase Investment
cx.log('\n=== 25. open-ended : quelles restrictions ? ===')
const VO = await vaultCreate(cx.client, O, { Asset: { currency: 'XRP' }, AssetsMaximum: '0', WithdrawalPolicy: 1 })
cx.rec('25.create', 'VaultCreate open-ended', 'sans VaultKind', VO)
cx.rec('25.dep', 'deposit open-ended', 'VaultDeposit 5 XRP', await submit(cx.client, depositTx(D, VO.vaultId, XRP(5)), D))
cx.rec('25.wd', 'withdraw open-ended', 'VaultWithdraw 1e6 parts', await submit(cx.client, withdrawTx(D, VO.vaultId, VO.mptId, 1_000_000), D))
cx.rec('25.set', 'VaultSet open-ended', 'VaultSet Data', await submit(cx.client, {
  TransactionType: 'VaultSet', Account: O.classicAddress, VaultID: VO.vaultId, Data: hex('x'),
}, O))
cx.rec('25.bset', 'LoanBrokerSet open-ended (attendu tecNO_PERMISSION)', 'LoanBrokerSet', await submit(cx.client, {
  TransactionType: 'LoanBrokerSet', Account: O.classicAddress, VaultID: VO.vaultId,
  DebtMaximum: '0', CoverRateMinimum: 0, CoverRateLiquidation: 0, ManagementFeeRate: 0,
}, O))
cx.rec('25.dates', 'VaultSet dates sur open-ended', 'VaultSet SubscriptionDate', await submit(cx.client, {
  TransactionType: 'VaultSet', Account: O.classicAddress, VaultID: VO.vaultId, SubscriptionDate: rippleNow() + 600,
}, O))

// ══ PHASE INVESTMENT ══
{
  const wait = sub - rippleNow() + 6
  if (wait > 0) { cx.log(`\nattente Investment (${wait}s)…`); await sleep(wait * 1000) }
}
await matrix('Investment')
await moveDates('Investment')

// ══ PHASE REDEMPTION ══
{
  const wait = red - rippleNow() + 6
  if (wait > 0) { cx.log(`\nattente Redemption (${wait}s)…`); await sleep(wait * 1000) }
}
await matrix('Redemption')
await moveDates('Redemption')

// ── 27 : VaultDelete, les conditions
cx.log('\n=== 27. VaultDelete : conditions ===')
cx.rec('27.shares', 'VaultDelete avec parts en circulation + broker', 'VaultDelete V1', await submit(cx.client, {
  TransactionType: 'VaultDelete', Account: O.classicAddress, VaultID: V1.vaultId,
}, O))
// D sort tout ce qu'il peut, puis on retente
const v1 = await cx.request({ command: 'vault_info', vault_id: V1.vaultId }).then(r => r.vault).catch(() => null)
if (v1) {
  const { shareBalance } = await import('@secondwave/core')
  const sb = await shareBalance(cx.client, D.classicAddress, V1.mptId)
  cx.note('27', `D détient ${sb.amount} parts ; vault AssetsTotal=${v1.AssetsTotal} AssetsAvailable=${v1.AssetsAvailable}`)
  if (sb.amount > 0n) {
    const wd = await submit(cx.client, withdrawTx(D, V1.vaultId, V1.mptId, sb.amount), D)
    cx.rec('27.exit', 'D retire TOUTES ses parts en Redemption (prêt en cours ?)', `VaultWithdraw ${sb.amount}`, wd)
  }
  cx.rec('27.broker', 'VaultDelete sans parts mais avec broker', 'VaultDelete V1', await submit(cx.client, {
    TransactionType: 'VaultDelete', Account: O.classicAddress, VaultID: V1.vaultId,
  }, O))
  if (BID) {
    const bd = await submit(cx.client, { TransactionType: 'LoanBrokerDelete', Account: O.classicAddress, LoanBrokerID: BID }, O)
    cx.rec('27.bdel', 'LoanBrokerDelete (prêt en cours ?)', 'LoanBrokerDelete', bd)
    cx.rec('27.clean', 'VaultDelete après suppression du broker', 'VaultDelete V1', await submit(cx.client, {
      TransactionType: 'VaultDelete', Account: O.classicAddress, VaultID: V1.vaultId,
    }, O))
  }
}

await cx.done()
