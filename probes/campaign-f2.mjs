// Campagne F (v2) — LoanSet et cycle de vie (63-80).
// Réutilise les wallets de state-f.json ; vault neuf (le premier run est mort
// sur le crash local-check du helper SDK, capturé — et GracePeriod=0 est
// invalide : 60 ≤ grace ≤ interval).
import fs from 'node:fs'
import {
  startCampaign, vaultCreate, depositTx,
  submit, submitLoanSet, createdIndex, rippleNow, sleep, XRP, hex,
  counterpartySign, Wallet,
} from './_lib.mjs'
import { signLoanSetByCounterparty, combineLoanSetCounterpartySigners } from 'xrpl'
import { encode, encodeForSigning } from 'ripple-binary-codec'
import { sign as kpSign } from 'ripple-keypairs'

const old = JSON.parse(fs.readFileSync(new URL('./state-f.json', import.meta.url), 'utf8'))
const cx = await startCampaign('f2')
const [O, D, BW, X, s1, s2] = ['O', 'D', 'BW', 'X', 's1', 's2'].map(k => Wallet.fromSeed(old.wallets[k].seed))
cx.log('wallets repris de state-f.json')

// ── au passage : récupérer le cover du broker orphelin du run 1 (57 : 100% à DebtTotal=0)
cx.rec('57.old', 'CoverWithdraw 100% (5 XRP) sur broker sans dette (run 1)', 'LoanBrokerCoverWithdraw', await submit(cx.client, {
  TransactionType: 'LoanBrokerCoverWithdraw', Account: O.classicAddress, LoanBrokerID: old.BF1, Amount: XRP(5),
}, O))

const sub = rippleNow() + 75
const red = sub + 800
const V = await vaultCreate(cx.client, O, {
  Asset: { currency: 'XRP' }, AssetsMaximum: '0', VaultKind: 1,
  SubscriptionDate: sub, RedemptionDate: red, WithdrawalPolicy: 1,
})
cx.rec('F0', 'VaultCreate v2', 'investment 800s', V)
cx.rec('F0.dep', 'D dépose 30 XRP', '', await submit(cx.client, depositTx(D, V.vaultId, XRP(30)), D))
cx.rec('F0.dep2', 'O dépose 20 XRP', '', await submit(cx.client, depositTx(O, V.vaultId, XRP(20)), O))

const b1 = await submit(cx.client, {
  TransactionType: 'LoanBrokerSet', Account: O.classicAddress, VaultID: V.vaultId,
  DebtMaximum: '0', CoverRateMinimum: 10000, CoverRateLiquidation: 50000, ManagementFeeRate: 10000,
}, O)
const BF1 = createdIndex(b1, 'LoanBroker')
cx.rec('F0.b1', 'LoanBrokerSet BF1 (mgmt fee 10000)', '', b1)
const b2 = await submit(cx.client, {
  TransactionType: 'LoanBrokerSet', Account: O.classicAddress, VaultID: V.vaultId,
  DebtMaximum: XRP(5), CoverRateMinimum: 0, CoverRateLiquidation: 0, ManagementFeeRate: 0,
}, O)
const BF2 = createdIndex(b2, 'LoanBroker')
cx.rec('F0.b2', 'LoanBrokerSet BF2 (DebtMax 5 XRP)', '', b2)
cx.rec('F0.cover', 'CoverDeposit 5 XRP sur BF1', '', await submit(cx.client, {
  TransactionType: 'LoanBrokerCoverDeposit', Account: O.classicAddress, LoanBrokerID: BF1, Amount: XRP(5),
}, O))
cx.saveState({ V: V.vaultId, mptId: V.mptId, BF1, BF2, sub, red })

const bal = async a => BigInt((await cx.request({ command: 'account_info', account: a, ledger_index: 'validated' })).account_data.Balance)
const vinfo = async () => (await cx.request({ command: 'vault_info', vault_id: V.vaultId })).vault

async function rawLoanSet(terms, borrower, cosign) {
  let tx
  try {
    tx = await cx.client.autofill({ TransactionType: 'LoanSet', Account: borrower.classicAddress, ...terms })
    tx.SigningPubKey = borrower.publicKey
    tx.TxnSignature = kpSign(encodeForSigning(tx), borrower.privateKey)
    const blob = cosign(tx)
    const r = await cx.client.request({ command: 'submit', tx_blob: blob })
    if (r.result.engine_result !== 'tesSUCCESS')
      return { result: r.result.engine_result, message: r.result.engine_result_message, hash: r.result.tx_json?.hash }
    return await cx.finalOf(r.result.tx_json.hash)
  } catch (e) {
    return { result: e.data?.error ?? 'exception', message: e.data?.error_exception ?? e.message }
  }
}
const baseTerms = () => ({
  LoanBrokerID: BF1, Counterparty: O.classicAddress,
  PrincipalRequested: XRP(2), PaymentInterval: 300, PaymentTotal: 1, GracePeriod: 60, InterestRate: 50000,
})

// ══ pendant la Subscription : les cas de niveau préflight/signature ══
cx.log('\n=== cas préflight (pendant la Subscription) ===')
cx.rec('63.sdk', 'co-signature via signLoanSetByCounterparty (SDK, STX\\0)', 'mêmes termes que 63.fix',
  await rawLoanSet(baseTerms(), BW, tx => {
    const signed = signLoanSetByCounterparty(O, tx)
    return typeof signed === 'string' ? signed : (signed.tx_blob ?? encode(signed))
  }))
cx.rec('65', 'LoanSet SANS CounterpartySignature', '', await rawLoanSet(baseTerms(), BW, tx => encode(tx)))
cx.rec('66', 'LoanSet co-signé par un TIERS (X)', '', await rawLoanSet(baseTerms(), BW, tx => {
  tx.CounterpartySignature = { SigningPubKey: X.publicKey, TxnSignature: counterpartySign(tx, X) }
  return encode(tx)
}))
cx.rec('74', 'LoanSet avec StartDate', 'StartDate=now+60',
  await submitLoanSet(cx.client, { TransactionType: 'LoanSet', Account: BW.classicAddress, ...baseTerms(), StartDate: rippleNow() + 60 }, BW, O))
cx.rec('70.zero', 'PaymentTotal: 0', '', await submitLoanSet(cx.client, {
  TransactionType: 'LoanSet', Account: BW.classicAddress, LoanBrokerID: BF2,
  PrincipalRequested: XRP(1), PaymentInterval: 300, PaymentTotal: 0, GracePeriod: 60, InterestRate: 0,
}, BW, O))
cx.rec('71.bounds', 'grace=59 interval=300 (borne basse grace)', '', await submitLoanSet(cx.client, {
  TransactionType: 'LoanSet', Account: BW.classicAddress, LoanBrokerID: BF2,
  PrincipalRequested: XRP(1), PaymentInterval: 300, PaymentTotal: 1, GracePeriod: 59, InterestRate: 0,
}, BW, O))
cx.rec('71.g>i', 'grace=301 > interval=300', '', await submitLoanSet(cx.client, {
  TransactionType: 'LoanSet', Account: BW.classicAddress, LoanBrokerID: BF2,
  PrincipalRequested: XRP(1), PaymentInterval: 300, PaymentTotal: 1, GracePeriod: 301, InterestRate: 0,
}, BW, O))
cx.rec('72.max', 'InterestRate 4294967295', '', await submitLoanSet(cx.client, {
  TransactionType: 'LoanSet', Account: BW.classicAddress, LoanBrokerID: BF2,
  PrincipalRequested: XRP(1), PaymentInterval: 300, PaymentTotal: 1, GracePeriod: 60, InterestRate: 4294967295,
}, BW, O))
// et le trou de la matrice B : LoanSet VALIDE en Subscription → code de phase ?
cx.rec('B21.lset.S', 'LoanSet VALIDE en Subscription (trou matrice B)', '',
  await submitLoanSet(cx.client, { TransactionType: 'LoanSet', Account: BW.classicAddress, ...baseTerms() }, BW, O))

// ══ Investment ══
{
  const wait = sub - rippleNow() + 6
  if (wait > 0) { cx.log(`attente Investment (${wait}s)…`); await sleep(wait * 1000) }
}
cx.rec('63.fix', 'co-signature via counterpartySign (CPT\\0) — mêmes termes que 63.sdk', '',
  await rawLoanSet(baseTerms(), BW, tx => {
    tx.CounterpartySignature = { SigningPubKey: O.publicKey, TxnSignature: counterpartySign(tx, O) }
    return encode(tx)
  }))
cx.rec('67', 'PrincipalRequested 100 XRP > AssetsAvailable ~50', '',
  await submitLoanSet(cx.client, { TransactionType: 'LoanSet', Account: BW.classicAddress, ...baseTerms(), PrincipalRequested: XRP(100) }, BW, O))
cx.rec('68', 'PrincipalRequested 6 XRP > DebtMaximum 5 XRP (BF2)', '',
  await submitLoanSet(cx.client, { TransactionType: 'LoanSet', Account: BW.classicAddress, ...baseTerms(), LoanBrokerID: BF2, PrincipalRequested: XRP(6) }, BW, O))

// ── 75 : Data accepté puis jeté ?
{
  const r = await submitLoanSet(cx.client, { TransactionType: 'LoanSet', Account: BW.classicAddress, ...baseTerms(), PrincipalRequested: XRP(1), Data: hex('coucou') }, BW, O)
  const lid = createdIndex(r, 'Loan')
  let dataOnLedger = '(pas de loan créé)'
  if (lid) { const l = await cx.entry(lid); dataOnLedger = l.Data ?? '(ABSENT de l\'objet)' }
  cx.rec('75', 'LoanSet avec Data="coucou"', '', r, '', `Data sur l'objet Loan: ${dataOnLedger}`)
}

// ── 69 : marge de fin vs RedemptionDate (grace fixe 60 ; + un cas grace 120)
cx.log('\n=== 69. marge dernière échéance vs RedemptionDate ===')
for (const m of [0, 30, 59, 60, 61, 120]) {
  const interval = red - rippleNow() - m
  const r = await submitLoanSet(cx.client, {
    TransactionType: 'LoanSet', Account: BW.classicAddress, LoanBrokerID: BF1,
    PrincipalRequested: XRP(1), PaymentInterval: interval, PaymentTotal: 1, GracePeriod: 60, InterestRate: 0,
  }, BW, O)
  cx.rec(`69.m${m}`, `fin à red−${m}s`, `interval=${interval}`, r)
}
{
  const interval = red - rippleNow() - 90
  cx.rec('69.grace', 'fin à red−90s, GracePeriod=120 (la grâce compte-t-elle ?)', `interval=${interval}`,
    await submitLoanSet(cx.client, {
      TransactionType: 'LoanSet', Account: BW.classicAddress, LoanBrokerID: BF1,
      PrincipalRequested: XRP(1), PaymentInterval: interval, PaymentTotal: 1, GracePeriod: 120, InterestRate: 0,
    }, BW, O))
}
// PaymentTotal énorme : interval 60 × total 4e9 → où ça casse ?
cx.rec('70.max', 'PaymentTotal 4294967295 (interval 60)', '', await submitLoanSet(cx.client, {
  TransactionType: 'LoanSet', Account: BW.classicAddress, LoanBrokerID: BF2,
  PrincipalRequested: XRP(1), PaymentInterval: 60, PaymentTotal: 4294967295, GracePeriod: 60, InterestRate: 0,
}, BW, O))

// ── 72 : l'unité d'InterestRate (LA 200s vs LB 400s, même taux)
async function mkAndRead(id, title, terms) {
  const r = await submitLoanSet(cx.client, { TransactionType: 'LoanSet', Account: BW.classicAddress, ...terms }, BW, O)
  const lid = createdIndex(r, 'Loan')
  let note = ''
  if (lid) {
    const l = await cx.entry(lid)
    note = `Principal=${l.PrincipalOutstanding} TVO=${l.TotalValueOutstanding} intérêt=${BigInt(l.TotalValueOutstanding ?? 0) - BigInt(l.PrincipalOutstanding ?? 0)}`
  }
  cx.rec(id, title, JSON.stringify({ i: terms.PaymentInterval, n: terms.PaymentTotal, r: terms.InterestRate }), r, '', note)
  return lid
}
await mkAndRead('72.r0', 'InterestRate 0 (contrôle)', { LoanBrokerID: BF2, PrincipalRequested: XRP(1), PaymentInterval: 300, PaymentTotal: 1, GracePeriod: 60, InterestRate: 0 })
const LA = await mkAndRead('72.rA', 'rate 100000, interval 200s', { LoanBrokerID: BF1, PrincipalRequested: XRP(10), PaymentInterval: 200, PaymentTotal: 1, GracePeriod: 60, InterestRate: 100000 })
const LB = await mkAndRead('72.rB', 'rate 100000, interval 400s', { LoanBrokerID: BF1, PrincipalRequested: XRP(10), PaymentInterval: 400, PaymentTotal: 1, GracePeriod: 60, InterestRate: 100000 })

// ── 73/76 : suivre l'argent, frais compris
cx.log('\n=== 73/76. suivre l\'argent ===')
const v0 = await vinfo()
const pseudo = v0.Account
const brokerObj = await cx.entry(BF1)
const pseudoBroker = brokerObj.Account
const before = { BW: await bal(BW.classicAddress), O: await bal(O.classicAddress), pv: await bal(pseudo), pb: await bal(pseudoBroker) }
cx.note('76', `avant LoanSet: BW=${before.BW} O=${before.O} pseudoVault=${before.pv} pseudoBroker=${before.pb} | AssetsTotal=${v0.AssetsTotal} AssetsAvailable=${v0.AssetsAvailable} Cover=${brokerObj.CoverAvailable}`)
const rF = await submitLoanSet(cx.client, {
  TransactionType: 'LoanSet', Account: BW.classicAddress, LoanBrokerID: BF1,
  PrincipalRequested: XRP(10), PaymentInterval: 90, PaymentTotal: 2, GracePeriod: 60, InterestRate: 50000,
  LoanOriginationFee: XRP(0.1), LoanServiceFee: XRP(0.01), LatePaymentFee: XRP(0.05),
}, BW, O)
const LF = createdIndex(rF, 'Loan')
cx.rec('76', 'LoanSet 10 XRP + origination 0.1 + service 0.01 + late 0.05', '', rF)
if (LF) {
  const after = { BW: await bal(BW.classicAddress), O: await bal(O.classicAddress), pv: await bal(pseudo), pb: await bal(pseudoBroker) }
  const v1 = await vinfo(); const bAfter = await cx.entry(BF1)
  cx.note('76', `delta: BW=${after.BW - before.BW} O=${after.O - before.O} pseudoVault=${after.pv - before.pv} pseudoBroker=${after.pb - before.pb}`)
  cx.note('76', `vault: AssetsTotal ${v0.AssetsTotal}→${v1.AssetsTotal} AssetsAvailable ${v0.AssetsAvailable}→${v1.AssetsAvailable} | Cover ${brokerObj.CoverAvailable}→${bAfter.CoverAvailable} DebtTotal=${bAfter.DebtTotal}`)
  cx.note('76', `loan LF: ${JSON.stringify(await cx.entry(LF))}`)
}

// ── 79/80 : remboursement anticipé intégral (LA, pas encore dû)
if (LA) {
  const l = await cx.entry(LA)
  const r = await submit(cx.client, {
    TransactionType: 'LoanPay', Account: BW.classicAddress, LoanID: LA, Amount: String(l.TotalValueOutstanding), Flags: 131072,
  }, BW)
  cx.rec('79', `LoanPay intégral anticipé (TVO=${l.TotalValueOutstanding}, tfLoanFullPayment)`, '', r)
  const after = await cx.entry(LA).catch(() => null)
  cx.rec('80', 'objet Loan après remboursement intégral', 'ledger_entry',
    after ? `TOUJOURS LÀ (Flags=${after.Flags} TVO=${after.TotalValueOutstanding})` : 'objet SUPPRIMÉ')
  if (after) cx.rec('80.del', 'LoanDelete sur prêt soldé', '', await submit(cx.client, {
    TransactionType: 'LoanDelete', Account: O.classicAddress, LoanID: LA,
  }, O))
}

// ── 64 : multisig CPM\0
cx.log('\n=== 64. multisig ===')
cx.rec('64.sl', 'SignerListSet 2-of-2 sur O', '', await submit(cx.client, {
  TransactionType: 'SignerListSet', Account: O.classicAddress, SignerQuorum: 2,
  SignerEntries: [
    { SignerEntry: { Account: s1.classicAddress, SignerWeight: 1 } },
    { SignerEntry: { Account: s2.classicAddress, SignerWeight: 1 } },
  ],
}, O))
cx.rec('64.cpm', 'LoanSet co-signé multisig (CPM\\0, s1+s2)', '',
  await rawLoanSet({ ...baseTerms(), PrincipalRequested: XRP(1) }, BW, tx => {
    const signers = [s1, s2].map(s => ({
      Signer: { Account: s.classicAddress, SigningPubKey: s.publicKey, TxnSignature: counterpartySign(tx, s, s.classicAddress) },
    })).sort((a, b) => (a.Signer.Account < b.Signer.Account ? -1 : 1))
    tx.CounterpartySignature = { Signers: signers }
    return encode(tx)
  }))
cx.rec('64.sdk', 'LoanSet multisig via helper SDK (multisign:true)', '',
  await rawLoanSet({ ...baseTerms(), PrincipalRequested: XRP(1) }, BW, tx => {
    const t1 = signLoanSetByCounterparty(s1, tx, { multisign: s1.classicAddress })
    const t2 = signLoanSetByCounterparty(s2, tx, { multisign: s2.classicAddress })
    const combined = combineLoanSetCounterpartySigners([t1.tx_blob ?? t1, t2.tx_blob ?? t2])
    return combined.tx_blob ?? combined
  }))

// ── B-fix : LoanSet VALIDE en Redemption (le vault du run 1 y est passé)
{
  const vOld = await cx.request({ command: 'vault_info', vault_id: old.V }).then(r => r.vault).catch(() => null)
  if (vOld && rippleNow() >= Number(vOld.RedemptionDate)) {
    cx.rec('B21.lset.R', 'LoanSet VALIDE en Redemption (vault run 1)', '',
      await submitLoanSet(cx.client, {
        TransactionType: 'LoanSet', Account: BW.classicAddress, LoanBrokerID: old.BF1,
        Counterparty: O.classicAddress, PrincipalRequested: XRP(1),
        PaymentInterval: 300, PaymentTotal: 1, GracePeriod: 60, InterestRate: 0,
      }, BW, O))
  } else cx.note('B21.lset.R', `vault run 1 pas encore en Redemption (red dans ${vOld ? Number(vOld.RedemptionDate) - rippleNow() : '?'}s) — sera refait`)
}

// ── 77/78 : LoanPay sur LF à l'échéance
if (LF) {
  const l = await cx.entry(LF)
  const wait = Number(l.NextPaymentDueDate) - rippleNow() + 5
  if (wait > 0) { cx.log(`attente 1re échéance LF (${wait}s)…`); await sleep(wait * 1000) }
  cx.note('77', `loan LF à l'échéance: ${JSON.stringify(await cx.entry(LF))}`)

  cx.rec('77.under', 'LoanPay sous-paiement 0.5 XRP', '', await submit(cx.client, {
    TransactionType: 'LoanPay', Account: BW.classicAddress, LoanID: LF, Amount: XRP(0.5),
  }, BW))
  cx.rec('78', 'LoanPay par un TIERS (X)', 'Amount 6 XRP', await submit(cx.client, {
    TransactionType: 'LoanPay', Account: X.classicAddress, LoanID: LF, Amount: XRP(6),
  }, X))

  const b0 = { BW: await bal(BW.classicAddress), pv: await bal(pseudo), pb: await bal(pseudoBroker), O: await bal(O.classicAddress) }
  cx.rec('77.pay', 'LoanPay 6 XRP (1re échéance, généreux)', '', await submit(cx.client, {
    TransactionType: 'LoanPay', Account: BW.classicAddress, LoanID: LF, Amount: XRP(6),
  }, BW))
  const b1 = { BW: await bal(BW.classicAddress), pv: await bal(pseudo), pb: await bal(pseudoBroker), O: await bal(O.classicAddress) }
  const v1 = await vinfo()
  cx.note('73', `LoanPay: delta BW=${b1.BW - b0.BW} pseudoVault=${b1.pv - b0.pv} pseudoBroker=${b1.pb - b0.pb} O=${b1.O - b0.O} | AssetsTotal=${v1.AssetsTotal} AssetsAvailable=${v1.AssetsAvailable}`)
  cx.note('77', `loan après paiement: ${JSON.stringify(await cx.entry(LF).catch(() => 'SUPPRIMÉ'))}`)

  cx.rec('77.over', 'LoanPay 20 XRP avec tfLoanOverpayment', '', await submit(cx.client, {
    TransactionType: 'LoanPay', Account: BW.classicAddress, LoanID: LF, Amount: XRP(20), Flags: 65536,
  }, BW))
  cx.note('77', `loan après sur-paiement: ${JSON.stringify(await cx.entry(LF).catch(() => 'SUPPRIMÉ'))}`)
}

await cx.done()
