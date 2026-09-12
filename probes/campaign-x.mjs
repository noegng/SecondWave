// Campagne X — contre-essais issus des campagnes précédentes :
//  X1  LoanBrokerSet "update" bien formé (VaultID + LoanBrokerID)      (54)
//  X2  affinage de la marge de fin de prêt (70..119s)                  (69)
//  X3  sémantique LoanPay : avant échéance, en retard sans/avec flag   (77, 73)
//  X4  sur-paiement avec le flag posé À LA CRÉATION + full payment     (77, 79)
//  X5  multisig CPM avec Signers triés par ID binaire                  (64)
//  X6  checks serveur bruts de VaultCreate (le SDK bloquait avant)     (2-8, 12, 17)
//  X7  plancher du cover, au drop près                                 (58)
//  X8  le prêt à l'abandon L4 : impair/défaut en Redemption, cure      (89, 90)
import fs from 'node:fs'
import {
  startCampaign, vaultCreate, depositTx,
  submit, safeLoanSet, createdIndex, rippleNow, sleep, XRP, hex,
  counterpartySign, Wallet,
} from './_lib.mjs'
import { encode, encodeForSigning } from 'ripple-binary-codec'
import { decodeAccountID } from 'ripple-address-codec'
import { sign as kpSign } from 'ripple-keypairs'

const gSt = JSON.parse(fs.readFileSync(new URL('./state-g.json', import.meta.url), 'utf8'))
const cx = await startCampaign('x')
const { XO, XD, XB } = await cx.fundMany(['XO', 'XD', 'XB'])
const s1 = Wallet.fromSeed(gSt.wallets.BW.seed)   // signers multisig recyclés
const s2 = Wallet.fromSeed(gSt.wallets.BW2.seed)

const sub = rippleNow() + 80
const red = sub + 560
const V = await vaultCreate(cx.client, XO, {
  Asset: { currency: 'XRP' }, AssetsMaximum: '0', VaultKind: 1,
  SubscriptionDate: sub, RedemptionDate: red, WithdrawalPolicy: 1,
})
cx.rec('X0', 'VaultCreate', '', V)
cx.rec('X0.dep', 'XD dépose 40 XRP', '', await submit(cx.client, depositTx(XD, V.vaultId, XRP(40)), XD))
const rb = await submit(cx.client, {
  TransactionType: 'LoanBrokerSet', Account: XO.classicAddress, VaultID: V.vaultId,
  DebtMaximum: '0', CoverRateMinimum: 10000, CoverRateLiquidation: 50000, ManagementFeeRate: 1000,
}, XO)
const BK = createdIndex(rb, 'LoanBroker')
cx.rec('X0.bk', 'broker 10000/50000 fee 1000', '', rb)
cx.rec('X0.cover', 'CoverDeposit 5 XRP', '', await submit(cx.client, {
  TransactionType: 'LoanBrokerCoverDeposit', Account: XO.classicAddress, LoanBrokerID: BK, Amount: XRP(5),
}, XO))
cx.saveState({ V: V.vaultId, mptId: V.mptId, BK, sub, red })

// ── X1 : l'update de broker, bien formé cette fois
for (const [k, fields] of [
  ['coverMin', { CoverRateMinimum: 20000 }],
  ['coverLiq', { CoverRateLiquidation: 60000 }],
  ['debtMax', { DebtMaximum: XRP(50) }],
  ['fee', { ManagementFeeRate: 500 }],
  ['data', { Data: hex('maj') }],
]) {
  const r = await submit(cx.client, {
    TransactionType: 'LoanBrokerSet', Account: XO.classicAddress, VaultID: V.vaultId, LoanBrokerID: BK, ...fields,
  }, XO)
  cx.rec(`X1.${k}`, `LoanBrokerSet update ${k}`, JSON.stringify(fields), r)
}
{ const b = await cx.entry(BK); cx.note('X1', `broker après updates: min=${b.CoverRateMinimum} liq=${b.CoverRateLiquidation} debtMax=${b.DebtMaximum} fee=${b.ManagementFeeRate} Data=${b.Data ?? '(absent)'}`) }

// ── X6 : les checks serveur bruts (fire = pas de validate SDK)
cx.log('\n=== X6. checks serveur bruts ===')
async function rawVC(id, title, fields, flags) {
  const tx = {
    TransactionType: 'VaultCreate', Account: XO.classicAddress,
    Asset: { currency: 'XRP' }, AssetsMaximum: '0', WithdrawalPolicy: 1,
    Fee: '200000', ...fields,
  }
  if (flags != null) tx.Flags = flags
  try {
    const f = await cx.fire(tx, XO)
    const fin = f.hash && f.engine?.startsWith('te') === false ? await cx.finalOf(f.hash, 10) : { result: f.engine }
    cx.rec(id, title, '', `${f.engine}${fin.result && fin.result !== f.engine ? ' → ' + fin.result : ''}`, '', f.message ?? '')
  } catch (e) { cx.rec(id, title, '', e.data?.error ?? e.message, '', e.data?.error_exception ?? '') }
}
{
  const s0 = rippleNow() + 3600
  await rawVC('X6.gap179', 'gap 179s (serveur)', { VaultKind: 1, SubscriptionDate: s0, RedemptionDate: s0 + 179 })
  await rawVC('X6.gap31y', 'gap 31 ans (serveur)', { VaultKind: 1, SubscriptionDate: s0, RedemptionDate: s0 + 31 * 31536000 })
  await rawVC('X6.nodates', 'VaultKind 1 sans dates (serveur)', { VaultKind: 1 })
  await rawVC('X6.kind2', 'VaultKind 2 (serveur)', { VaultKind: 2, SubscriptionDate: s0, RedemptionDate: s0 + 600 })
  await rawVC('X6.kind0', 'VaultKind 0 explicite + dates (serveur)', { VaultKind: 0, SubscriptionDate: s0, RedemptionDate: s0 + 600 })
  await rawVC('X6.scaleXRP', 'Scale 6 sur XRP (serveur)', { Scale: 6 })
  await rawVC('X6.domNoFlag', 'DomainID sans tfVaultPrivate (serveur)', { DomainID: 'AB'.repeat(32) })
}
// LoanBrokerSet brut : un seul CoverRate non nul, fee 20000
{
  const f1 = await cx.fire({
    TransactionType: 'LoanBrokerSet', Account: XO.classicAddress, VaultID: V.vaultId,
    DebtMaximum: '0', CoverRateMinimum: 10000, CoverRateLiquidation: 0, ManagementFeeRate: 0, Fee: '15',
  }, XO)
  const fin1 = f1.hash ? await cx.finalOf(f1.hash, 10) : { result: f1.engine }
  cx.rec('X6.oneRate', 'CoverRateMinimum seul non nul (serveur)', '', `${f1.engine} → ${fin1.result ?? '?'}`, '', f1.message ?? '')
  const f2 = await cx.fire({
    TransactionType: 'LoanBrokerSet', Account: XO.classicAddress, VaultID: V.vaultId,
    DebtMaximum: '0', CoverRateMinimum: 0, CoverRateLiquidation: 0, ManagementFeeRate: 20000, Fee: '15',
  }, XO)
  const fin2 = f2.hash ? await cx.finalOf(f2.hash, 10) : { result: f2.engine }
  cx.rec('X6.fee20k', 'ManagementFeeRate 20000 (serveur)', '', `${f2.engine} → ${fin2.result ?? '?'}`, '', f2.message ?? '')
}

// ══ Investment ══
{
  const wait = sub - rippleNow() + 6
  if (wait > 0) { cx.log(`attente Investment (${wait}s)…`); await sleep(wait * 1000) }
}

// ── X3 : le prêt de la sémantique LoanPay
const rl = await safeLoanSet(cx.client, {
  TransactionType: 'LoanSet', Account: XB.classicAddress, LoanBrokerID: BK,
  PrincipalRequested: XRP(10), PaymentInterval: 150, PaymentTotal: 2, GracePeriod: 60, InterestRate: 50000,
  LoanServiceFee: XRP(0.01), LatePaymentFee: XRP(0.05),
}, XB, XO)
const LP = createdIndex(rl, 'Loan')
cx.rec('X3.loan', 'LoanSet 10 XRP interval 150 total 2 (service 0.01, late 0.05)', '', rl)
const bal = async a => BigInt((await cx.request({ command: 'account_info', account: a, ledger_index: 'validated' })).account_data.Balance)
const vinfo = async () => (await cx.request({ command: 'vault_info', vault_id: V.vaultId })).vault
const pseudo = (await vinfo()).Account
const pseudoBroker = (await cx.entry(BK)).Account

if (LP) {
  const l0 = await cx.entry(LP)
  cx.note('X3', `loan: PeriodicPayment=${l0.PeriodicPayment} Next=${l0.NextPaymentDueDate} (dans ${Number(l0.NextPaymentDueDate) - rippleNow()}s) TVO=${l0.TotalValueOutstanding} MgmtFeeOut=${l0.ManagementFeeOutstanding}`)
  // a. paiement AVANT l'échéance (période en cours) — permis ?
  const pay1 = Math.ceil(Number(l0.PeriodicPayment)) + 10000 // PeriodicPayment + service fee 0.01 XRP
  const b0 = { XB: await bal(XB.classicAddress), pv: await bal(pseudo), pb: await bal(pseudoBroker), XO: await bal(XO.classicAddress) }
  const rp1 = await submit(cx.client, { TransactionType: 'LoanPay', Account: XB.classicAddress, LoanID: LP, Amount: String(pay1) }, XB)
  cx.rec('X3.early', `LoanPay ${pay1} drops AVANT l'échéance (échéance+service)`, '', rp1)
  if (rp1.ok) {
    const b1 = { XB: await bal(XB.classicAddress), pv: await bal(pseudo), pb: await bal(pseudoBroker), XO: await bal(XO.classicAddress) }
    const v1 = await vinfo()
    cx.note('X3.flux', `delta XB=${b1.XB - b0.XB} pseudoVault=${b1.pv - b0.pv} pseudoBroker=${b1.pb - b0.pb} XO=${b1.XO - b0.XO} | AssetsTotal=${v1.AssetsTotal} AssetsAvailable=${v1.AssetsAvailable}`)
    cx.note('X3.flux', `loan après: ${JSON.stringify(await cx.entry(LP))}`)
  }
}

// ── X4 : overpayment/full payment avec le flag posé À LA CRÉATION
const ro = await safeLoanSet(cx.client, {
  TransactionType: 'LoanSet', Account: XB.classicAddress, LoanBrokerID: BK,
  PrincipalRequested: XRP(5), PaymentInterval: 200, PaymentTotal: 2, GracePeriod: 60, InterestRate: 50000,
  Flags: 65536,   // tfLoanOverpayment à la création
}, XB, XO)
const LO = createdIndex(ro, 'Loan')
cx.rec('X4.loan', 'LoanSet 5 XRP avec Flags=tfLoanOverpayment', '', ro, '', LO ? `Flags objet=${(await cx.entry(LO)).Flags}` : '')
if (LO) {
  cx.rec('X4.over', 'LoanPay 3 XRP flag tfLoanOverpayment (avant échéance)', '', await submit(cx.client, {
    TransactionType: 'LoanPay', Account: XB.classicAddress, LoanID: LO, Amount: XRP(3), Flags: 65536,
  }, XB))
  cx.note('X4', `loan après overpay: ${JSON.stringify(await cx.entry(LO).catch(() => 'SUPPRIMÉ'))}`)
  const lNow = await cx.entry(LO).catch(() => null)
  if (lNow) {
    cx.rec('X4.full', `LoanPay TVO complet (${lNow.TotalValueOutstanding}) flag tfLoanFullPayment`, '', await submit(cx.client, {
      TransactionType: 'LoanPay', Account: XB.classicAddress, LoanID: LO, Amount: String(BigInt(lNow.TotalValueOutstanding) + 100000n), Flags: 131072,
    }, XB))
    const after = await cx.entry(LO).catch(() => null)
    cx.rec('X4.obj', 'objet après full payment', '', after ? `TOUJOURS LÀ TVO=${after.TotalValueOutstanding} Flags=${after.Flags}` : 'SUPPRIMÉ')
    if (after && after.TotalValueOutstanding === '0') {
      cx.rec('X4.del', 'LoanDelete sur prêt soldé', '', await submit(cx.client, {
        TransactionType: 'LoanDelete', Account: XO.classicAddress, LoanID: LO,
      }, XO))
    }
  }
}

// ── X2 : affinage de la marge de fin
cx.log('\n=== X2. marge fine ===')
for (const m of [70, 85, 90, 95, 105, 119]) {
  const interval = red - rippleNow() - m
  const r = await safeLoanSet(cx.client, {
    TransactionType: 'LoanSet', Account: XB.classicAddress, LoanBrokerID: BK,
    PrincipalRequested: XRP(0.5), PaymentInterval: interval, PaymentTotal: 1, GracePeriod: 60, InterestRate: 0,
  }, XB, XO)
  cx.rec(`X2.m${m}`, `fin à red−${m}s`, `interval=${interval}`, r, '', r.message ?? '')
}

// ── X7 : le plancher du cover au drop près (dette connue)
{
  const b = await cx.entry(BK)
  const debt = BigInt(b.DebtTotal ?? 0)
  const cover = BigInt(b.CoverAvailable ?? 0)
  const minRate = BigInt(b.CoverRateMinimum ?? 0)
  const floor = debt * minRate / 100000n   // hypothèse 1/1e5
  cx.note('X7', `debt=${debt} cover=${cover} minRate=${minRate} → plancher supposé (1/1e5) = ${floor}`)
  if (cover > floor) {
    cx.rec('X7.toFloor', `CoverWithdraw ${cover - floor} (laisse pile le plancher)`, '', await submit(cx.client, {
      TransactionType: 'LoanBrokerCoverWithdraw', Account: XO.classicAddress, LoanBrokerID: BK, Amount: String(cover - floor),
    }, XO))
    cx.rec('X7.one', 'CoverWithdraw 1 drop de plus', '', await submit(cx.client, {
      TransactionType: 'LoanBrokerCoverWithdraw', Account: XO.classicAddress, LoanBrokerID: BK, Amount: '1',
    }, XO))
    const b2 = await cx.entry(BK)
    cx.note('X7', `CoverAvailable final=${b2.CoverAvailable} (plancher supposé ${floor})`)
  }
}

// ── X5 : multisig CPM, Signers triés par ID binaire
cx.rec('X5.sl', 'SignerListSet 2-of-2 sur XO', '', await submit(cx.client, {
  TransactionType: 'SignerListSet', Account: XO.classicAddress, SignerQuorum: 2,
  SignerEntries: [
    { SignerEntry: { Account: s1.classicAddress, SignerWeight: 1 } },
    { SignerEntry: { Account: s2.classicAddress, SignerWeight: 1 } },
  ],
}, XO))
{
  const cmp = (a, b) => Buffer.compare(decodeAccountID(a.Signer.Account), decodeAccountID(b.Signer.Account))
  try {
    const tx = await cx.client.autofill({
      TransactionType: 'LoanSet', Account: XB.classicAddress, LoanBrokerID: BK,
      Counterparty: XO.classicAddress, PrincipalRequested: XRP(0.5),
      PaymentInterval: 200, PaymentTotal: 1, GracePeriod: 60, InterestRate: 0,
    })
    tx.SigningPubKey = XB.publicKey
    tx.TxnSignature = kpSign(encodeForSigning(tx), XB.privateKey)
    const signers = [s1, s2].map(s => ({
      Signer: { Account: s.classicAddress, SigningPubKey: s.publicKey, TxnSignature: counterpartySign(tx, s, s.classicAddress) },
    })).sort(cmp)
    tx.CounterpartySignature = { Signers: signers }
    const r = await cx.client.request({ command: 'submit', tx_blob: encode(tx) })
    const fin = r.result.engine_result === 'tesSUCCESS' ? await cx.finalOf(r.result.tx_json.hash) : { result: r.result.engine_result }
    cx.rec('X5.cpm', 'LoanSet multisig CPM\\0 (tri binaire)', '', fin.result, '', r.result.engine_result_message ?? '')
  } catch (e) {
    cx.rec('X5.cpm', 'LoanSet multisig CPM\\0 (tri binaire)', '', e.data?.error ?? e.message, '', e.data?.error_exception ?? '')
  }
}

// ── X3 suite : le retard (attendre l'échéance de LP, déjà payée 1 fois → Next+150)
if (LP) {
  const l = await cx.entry(LP).catch(() => null)
  if (l && l.PaymentRemaining) {
    const due = Number(l.NextPaymentDueDate)
    const wait = due + 8 - rippleNow()
    if (wait > 0 && wait < 300) { cx.log(`attente dépassement d'échéance LP (${wait}s)…`); await sleep(wait * 1000) }
    cx.rec('X3.lateNoFlag', 'LoanPay APRÈS échéance SANS flag', '', await submit(cx.client, {
      TransactionType: 'LoanPay', Account: XB.classicAddress, LoanID: LP, Amount: XRP(6),
    }, XB))
    const b0 = { XB: await bal(XB.classicAddress), pv: await bal(pseudo), pb: await bal(pseudoBroker), XO: await bal(XO.classicAddress) }
    const rLate = await submit(cx.client, {
      TransactionType: 'LoanPay', Account: XB.classicAddress, LoanID: LP, Amount: XRP(6), Flags: 262144,   // tfLoanLatePayment
    }, XB)
    cx.rec('X3.lateFlag', 'LoanPay APRÈS échéance AVEC tfLoanLatePayment', '', rLate)
    if (rLate.ok) {
      const b1 = { XB: await bal(XB.classicAddress), pv: await bal(pseudo), pb: await bal(pseudoBroker), XO: await bal(XO.classicAddress) }
      cx.note('X3.late', `delta XB=${b1.XB - b0.XB} pseudoVault=${b1.pv - b0.pv} pseudoBroker=${b1.pb - b0.pb} XO=${b1.XO - b0.XO} (late fee 0.05 XRP → qui ?)`)
      cx.note('X3.late', `loan après retard payé: ${JSON.stringify(await cx.entry(LP).catch(() => 'SUPPRIMÉ'))}`)
    }
  }
}

// ── X8 : le prêt à l'abandon L4 (vault G run 1, en Redemption)
{
  const O_g = Wallet.fromSeed(gSt.wallets.O.seed)
  const BW2_g = Wallet.fromSeed(gSt.wallets.BW2.seed)
  const l4 = await cx.entry(gSt.L4).catch(() => null)
  if (l4) {
    cx.note('X8', `L4: Principal=${l4.PrincipalOutstanding} Next=${l4.NextPaymentDueDate} (retard ${rippleNow() - Number(l4.NextPaymentDueDate)}s) Flags=${l4.Flags}`)
    cx.rec('X8.cure', 'LoanPay tardif AVEC flag sur prêt abandonné (Redemption)', '', await submit(cx.client, {
      TransactionType: 'LoanPay', Account: BW2_g.classicAddress, LoanID: gSt.L4, Amount: XRP(3), Flags: 262144,
    }, BW2_g))
    cx.rec('X8.impair', 'tfLoanImpair en Redemption', '', await submit(cx.client, {
      TransactionType: 'LoanManage', Account: O_g.classicAddress, LoanID: gSt.L4, Flags: 131072,
    }, O_g))
    const vOld0 = await cx.request({ command: 'vault_info', vault_id: gSt.V }).then(r => r.vault)
    cx.rec('X8.default', 'tfLoanDefault en Redemption (cover 0, D déjà sorti à 82%)', '', await submit(cx.client, {
      TransactionType: 'LoanManage', Account: O_g.classicAddress, LoanID: gSt.L4, Flags: 65536,
    }, O_g))
    const vOld1 = await cx.request({ command: 'vault_info', vault_id: gSt.V }).then(r => r.vault)
    cx.note('X8', `vault G1: AssetsTotal ${vOld0.AssetsTotal ?? 0}→${vOld1.AssetsTotal ?? 0} AssetsAvailable ${vOld0.AssetsAvailable ?? 0}→${vOld1.AssetsAvailable ?? 0} parts=${vOld1.shares.OutstandingAmount}`)
  } else cx.note('X8', 'L4 introuvable')
}

await cx.done()
