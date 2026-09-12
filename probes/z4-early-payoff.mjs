// Z4 — LE remboursement anticipé intégral existe-t-il finalement ?
// Découverte accidentelle (annexe Z) : un LoanPay dont Amount ≥ TVO semble solder
// le prêt SANS flag, alors que tfLoanFullPayment donne tecKILLED [F-79/X4].
// Test propre, à échelle réelle (6 XRP), en MILIEU de période 1 :
//   L1 : LoanPay Amount = TVO + 1 XRP, SANS flag       → solde ?
//   L2 : LoanPay Amount = TVO exact,   SANS flag       → solde ?
//   L3 : LoanPay Amount = TVO + 1 XRP, AVEC tfLoanFullPayment (contrôle tecKILLED)
import {
  startCampaign, vaultCreate, depositTx, submit, safeLoanSet, createdIndex,
  rippleNow, sleep, XRP,
} from './_lib.mjs'

const cx = await startCampaign('z4')
const { O, B } = await cx.fundMany(['O', 'B'])

const sub = rippleNow() + 65
const red = sub + 520
const V = await vaultCreate(cx.client, O, {
  Asset: { currency: 'XRP' }, AssetsMaximum: '0', VaultKind: 1,
  SubscriptionDate: sub, RedemptionDate: red, WithdrawalPolicy: 1,
})
await submit(cx.client, depositTx(O, V.vaultId, XRP(40)), O)
const rb = await submit(cx.client, {
  TransactionType: 'LoanBrokerSet', Account: O.classicAddress, VaultID: V.vaultId,
  DebtMaximum: '0', CoverRateMinimum: 0, CoverRateLiquidation: 0, ManagementFeeRate: 0,
}, O)
const BK = createdIndex(rb, 'LoanBroker')
{ const w = sub - rippleNow() + 6; if (w > 0) { cx.log(`attente Investment (${w}s)…`); await sleep(w * 1000) } }

async function mkLoan(id) {
  const r = await safeLoanSet(cx.client, {
    TransactionType: 'LoanSet', Account: B.classicAddress, LoanBrokerID: BK,
    PrincipalRequested: XRP(6), PaymentInterval: 120, PaymentTotal: 2, GracePeriod: 60, InterestRate: 50000,
  }, B, O)
  const L = createdIndex(r, 'Loan')
  cx.rec(id, 'LoanSet 6 XRP interval 120 total 2', '', r)
  return L
}
const L1 = await mkLoan('Z4.L1')
const L2 = await mkLoan('Z4.L2')
const L3 = await mkLoan('Z4.L3')

async function payAndInspect(id, L, mkAmount, flags) {
  const l = await cx.entry(L)
  const amount = mkAmount(l)
  const r = await submit(cx.client, {
    TransactionType: 'LoanPay', Account: B.classicAddress, LoanID: L, Amount: String(amount),
    ...(flags ? { Flags: flags } : {}),
  }, B)
  const after = await cx.entry(L).catch(() => null)
  const settled = after && after.TotalValueOutstanding == null
  cx.rec(id, `LoanPay ${amount}${flags ? ' +flag ' + flags : ' SANS flag'} (TVO était ${l.TotalValueOutstanding}, mi-période 1)`, '', r, '',
    after ? (settled ? '→ prêt SOLDÉ (champs purgés)' : `→ TVO=${after.TotalValueOutstanding} PayRemaining=${after.PaymentRemaining}`) : '→ objet supprimé')
  if (r.ok && r.meta) {
    for (const n of r.meta.AffectedNodes ?? []) {
      const [, node] = Object.entries(n)[0]
      if (node.LedgerEntryType === 'AccountRoot' && node.PreviousFields?.Balance)
        cx.note(id, `  ${node.FinalFields.Account.slice(0, 8)}: ${BigInt(node.FinalFields.Balance) - BigInt(node.PreviousFields.Balance)} drops`)
    }
  }
}

// mi-période 1 (aucune échéance encore due) :
await payAndInspect('Z4.noflag+1', L1, l => BigInt(l.TotalValueOutstanding) + 1_000_000n, 0)
await payAndInspect('Z4.noflag=', L2, l => BigInt(l.TotalValueOutstanding), 0)
await payAndInspect('Z4.fullflag', L3, l => BigInt(l.TotalValueOutstanding) + 1_000_000n, 131072)

const v1 = (await cx.request({ command: 'vault_info', vault_id: V.vaultId })).vault
cx.note('Z4', `vault final: AssetsTotal=${v1.AssetsTotal} AssetsAvailable=${v1.AssetsAvailable}`)
await cx.done()
