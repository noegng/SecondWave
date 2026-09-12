// Campagne F — LoanSet et cycle de vie du prêt (63-80).
// Le point noir : la co-signature (bug STX\0 vs CPT\0/CPM\0 du SDK).
import {
  startCampaign, vaultCreate, depositTx,
  submit, submitLoanSet, createdIndex, rippleNow, sleep, XRP, hex,
  counterpartySign, sequence,
} from './_lib.mjs'
import { signLoanSetByCounterparty } from 'xrpl'
import { encode, encodeForSigning } from 'ripple-binary-codec'
import { sign as kpSign } from 'ripple-keypairs'

const cx = await startCampaign('f')
const { O, D, BW, X, s1, s2 } = await cx.fundMany(['O', 'D', 'BW', 'X', 's1', 's2'])

const sub = rippleNow() + 100
const red = sub + 960
const V = await vaultCreate(cx.client, O, {
  Asset: { currency: 'XRP' }, AssetsMaximum: '0', VaultKind: 1,
  SubscriptionDate: sub, RedemptionDate: red, WithdrawalPolicy: 1,
})
cx.rec('F0', 'VaultCreate', 'closed, investment 960s', V)
cx.rec('F0.dep', 'D dépose 60 XRP', '', await submit(cx.client, depositTx(D, V.vaultId, XRP(60)), D))

const b1 = await submit(cx.client, {
  TransactionType: 'LoanBrokerSet', Account: O.classicAddress, VaultID: V.vaultId,
  DebtMaximum: '0', CoverRateMinimum: 10000, CoverRateLiquidation: 50000, ManagementFeeRate: 10000,
}, O)
const BF1 = createdIndex(b1, 'LoanBroker')
cx.rec('F0.b1', 'LoanBrokerSet BF1 (fee 10000, cover min 10000)', '', b1)
const b2 = await submit(cx.client, {
  TransactionType: 'LoanBrokerSet', Account: O.classicAddress, VaultID: V.vaultId,
  DebtMaximum: XRP(5), CoverRateMinimum: 0, CoverRateLiquidation: 0, ManagementFeeRate: 0,
}, O)
const BF2 = createdIndex(b2, 'LoanBroker')
cx.rec('F0.b2', 'LoanBrokerSet BF2 (DebtMaximum 5 XRP, rates 0/0)', '', b2)
cx.rec('F0.cover', 'CoverDeposit 5 XRP sur BF1', '', await submit(cx.client, {
  TransactionType: 'LoanBrokerCoverDeposit', Account: O.classicAddress, LoanBrokerID: BF1, Amount: XRP(5),
}, O))
cx.saveState({ V: V.vaultId, mptId: V.mptId, BF1, BF2, sub, red })

const bal = async a => BigInt((await cx.request({ command: 'account_info', account: a, ledger_index: 'validated' })).account_data.Balance)
const vinfo = async () => (await cx.request({ command: 'vault_info', vault_id: V.vaultId })).vault

/** LoanSet bâti à la main : premier signataire BW, co-signature injectée par cosign(tx). */
async function rawLoanSet(terms, borrower, cosign, label) {
  const tx = await cx.client.autofill({
    TransactionType: 'LoanSet', Account: borrower.classicAddress, ...terms,
  })
  tx.SigningPubKey = borrower.publicKey
  tx.TxnSignature = kpSign(encodeForSigning(tx), borrower.privateKey)
  let blob
  try { blob = cosign(tx) } catch (e) { return { result: 'exception client', message: e.message } }
  const r = await cx.client.request({ command: 'submit', tx_blob: blob })
  if (r.result.engine_result !== 'tesSUCCESS')
    return { result: r.result.engine_result, message: r.result.engine_result_message, hash: r.result.tx_json?.hash }
  return await cx.finalOf(r.result.tx_json.hash)
}

{
  const wait = sub - rippleNow() + 6
  if (wait > 0) { cx.log(`attente Investment (${wait}s)…`); await sleep(wait * 1000) }
}

const baseTerms = () => ({
  LoanBrokerID: BF1, Counterparty: O.classicAddress,
  PrincipalRequested: XRP(2), PaymentInterval: 300, PaymentTotal: 1, GracePeriod: 0, InterestRate: 50000,
})

// ── 63 : helper du SDK (STX\0) vs fix CPT\0, côte à côte
cx.rec('63.sdk', 'LoanSet co-signé par signLoanSetByCounterparty (SDK, préfixe STX)', 'mêmes termes',
  await rawLoanSet(baseTerms(), BW, tx => {
    const signed = signLoanSetByCounterparty(O, tx)
    return typeof signed === 'string' ? signed : (signed.tx_blob ?? encode(signed))
  }, 'sdk'))
cx.rec('63.fix', 'LoanSet co-signé via counterpartySign (CPT\\0)', 'mêmes termes',
  await rawLoanSet(baseTerms(), BW, tx => {
    tx.CounterpartySignature = { SigningPubKey: O.publicKey, TxnSignature: counterpartySign(tx, O) }
    return encode(tx)
  }, 'fix'))

// ── 65 : pas de CounterpartySignature du tout
cx.rec('65', 'LoanSet SANS CounterpartySignature', '',
  await rawLoanSet(baseTerms(), BW, tx => encode(tx)))

// ── 66 : co-signé par le MAUVAIS compte (X n'est pas le broker owner)
cx.rec('66', 'LoanSet co-signé par un tiers (X)', '',
  await rawLoanSet(baseTerms(), BW, tx => {
    tx.CounterpartySignature = { SigningPubKey: X.publicKey, TxnSignature: counterpartySign(tx, X) }
    return encode(tx)
  }))

// ── 67 / 68 : dépassements
cx.rec('67', 'PrincipalRequested (100 XRP) > AssetsAvailable (~60)', '',
  await submitLoanSet(cx.client, { TransactionType: 'LoanSet', Account: BW.classicAddress, ...baseTerms(), PrincipalRequested: XRP(100) }, BW, O))
cx.rec('68', 'PrincipalRequested (6 XRP) > DebtMaximum broker (5 XRP)', '',
  await submitLoanSet(cx.client, { TransactionType: 'LoanSet', Account: BW.classicAddress, ...baseTerms(), LoanBrokerID: BF2, PrincipalRequested: XRP(6) }, BW, O))

// ── 74 : StartDate — champ interdit, message exact
cx.rec('74', 'LoanSet avec StartDate', 'StartDate=now+60',
  await submitLoanSet(cx.client, { TransactionType: 'LoanSet', Account: BW.classicAddress, ...baseTerms(), StartDate: rippleNow() + 60 }, BW, O))

// ── 75 : Data accepté puis jeté
{
  const r = await submitLoanSet(cx.client, { TransactionType: 'LoanSet', Account: BW.classicAddress, ...baseTerms(), Data: hex('coucou') }, BW, O)
  const lid = createdIndex(r, 'Loan')
  let dataOnLedger = '(pas de loan)'
  if (lid) { const l = await cx.entry(lid); dataOnLedger = l.Data ?? '(absent)' }
  cx.rec('75', 'LoanSet avec Data', 'Data="coucou"', r, '', `Data sur l'objet Loan: ${dataOnLedger}`)
}

// ── 69 : la contrainte de fin — balayage des marges avant RedemptionDate
cx.log('\n=== 69. marge dernière échéance vs RedemptionDate ===')
for (const m of [0, 30, 59, 60, 61, 120]) {
  const interval = red - rippleNow() - m
  const r = await submitLoanSet(cx.client, {
    TransactionType: 'LoanSet', Account: BW.classicAddress, LoanBrokerID: BF1,
    PrincipalRequested: XRP(1), PaymentInterval: interval, PaymentTotal: 1, GracePeriod: 0, InterestRate: 0,
  }, BW, O)
  cx.rec(`69.m${m}`, `fin à RedemptionDate−${m}s`, `interval=${interval}`, r)
}
// la grâce compte-t-elle dans la contrainte ? fin à red−90 avec grace 120
{
  const interval = red - rippleNow() - 90
  const r = await submitLoanSet(cx.client, {
    TransactionType: 'LoanSet', Account: BW.classicAddress, LoanBrokerID: BF1,
    PrincipalRequested: XRP(1), PaymentInterval: interval, PaymentTotal: 1, GracePeriod: 120, InterestRate: 0,
  }, BW, O)
  cx.rec('69.grace', 'fin à red−90s mais GracePeriod=120s', `interval=${interval} grace=120`, r)
}

// ── 70 / 71 : PaymentTotal et PaymentInterval aux bornes
cx.rec('70.zero', 'PaymentTotal: 0', '', await submitLoanSet(cx.client, {
  TransactionType: 'LoanSet', Account: BW.classicAddress, LoanBrokerID: BF2,
  PrincipalRequested: XRP(1), PaymentInterval: 60, PaymentTotal: 0, GracePeriod: 0, InterestRate: 0,
}, BW, O))
cx.rec('70.max', 'PaymentTotal: 4294967295', '', await submitLoanSet(cx.client, {
  TransactionType: 'LoanSet', Account: BW.classicAddress, LoanBrokerID: BF2,
  PrincipalRequested: XRP(1), PaymentInterval: 1, PaymentTotal: 4294967295, GracePeriod: 0, InterestRate: 0,
}, BW, O))
cx.rec('71.i0', 'PaymentInterval: 0', '', await submitLoanSet(cx.client, {
  TransactionType: 'LoanSet', Account: BW.classicAddress, LoanBrokerID: BF2,
  PrincipalRequested: XRP(1), PaymentInterval: 0, PaymentTotal: 1, GracePeriod: 0, InterestRate: 0,
}, BW, O))
{
  const r = await submitLoanSet(cx.client, {
    TransactionType: 'LoanSet', Account: BW.classicAddress, LoanBrokerID: BF2,
    PrincipalRequested: XRP(1), PaymentInterval: 1, PaymentTotal: 30, GracePeriod: 0, InterestRate: 0,
  }, BW, O)
  cx.rec('71.i1', 'PaymentInterval: 1s (total 30)', '', r, '', createdIndex(r, 'Loan') ? 'prêt d\'une demi-minute créé' : '')
}

// ── 72 : InterestRate — unité et bornes
async function mkAndRead(id, title, terms) {
  const r = await submitLoanSet(cx.client, { TransactionType: 'LoanSet', Account: BW.classicAddress, ...terms }, BW, O)
  const lid = createdIndex(r, 'Loan')
  let note = ''
  if (lid) {
    const l = await cx.entry(lid)
    note = `Principal=${l.PrincipalOutstanding} TVO=${l.TotalValueOutstanding} intérêt=${BigInt(l.TotalValueOutstanding ?? 0) - BigInt(l.PrincipalOutstanding ?? 0)} champs=${Object.keys(l).join(',')}`
  }
  cx.rec(id, title, JSON.stringify({ i: terms.PaymentInterval, n: terms.PaymentTotal, r: terms.InterestRate }), r, '', note)
  return lid
}
await mkAndRead('72.r0', 'InterestRate 0', { LoanBrokerID: BF2, PrincipalRequested: XRP(1), PaymentInterval: 300, PaymentTotal: 1, GracePeriod: 0, InterestRate: 0 })
const LA = await mkAndRead('72.rA', 'rate 100000, interval 200s', { LoanBrokerID: BF1, PrincipalRequested: XRP(10), PaymentInterval: 200, PaymentTotal: 1, GracePeriod: 0, InterestRate: 100000 })
const LB = await mkAndRead('72.rB', 'rate 100000, interval 400s', { LoanBrokerID: BF1, PrincipalRequested: XRP(10), PaymentInterval: 400, PaymentTotal: 1, GracePeriod: 0, InterestRate: 100000 })
cx.rec('72.max', 'InterestRate 4294967295', '', await submitLoanSet(cx.client, {
  TransactionType: 'LoanSet', Account: BW.classicAddress, LoanBrokerID: BF2,
  PrincipalRequested: XRP(1), PaymentInterval: 60, PaymentTotal: 1, GracePeriod: 0, InterestRate: 4294967295,
}, BW, O))

// ── 73 + 76 : le prêt "suivi de l'argent" — frais compris
cx.log('\n=== 73/76. suivre l\'argent drop par drop ===')
const before = { BW: await bal(BW.classicAddress), O: await bal(O.classicAddress), vault: await vinfo() }
const pseudo = before.vault.Account
before.pseudoBal = await bal(pseudo)
const brokerObj = await cx.entry(BF1)
const pseudoBroker = brokerObj.Account
before.pseudoBrokerBal = await bal(pseudoBroker)
cx.note('76', `avant LoanSet: BW=${before.BW} O=${before.O} pseudoVault=${before.pseudoBal} pseudoBroker=${before.pseudoBrokerBal} AssetsTotal=${before.vault.AssetsTotal} AssetsAvailable=${before.vault.AssetsAvailable} Cover=${brokerObj.CoverAvailable}`)

const rF = await submitLoanSet(cx.client, {
  TransactionType: 'LoanSet', Account: BW.classicAddress, LoanBrokerID: BF1,
  PrincipalRequested: XRP(10), PaymentInterval: 90, PaymentTotal: 2, GracePeriod: 60, InterestRate: 50000,
  LoanOriginationFee: XRP(0.1), LoanServiceFee: XRP(0.01), LatePaymentFee: XRP(0.05),
}, BW, O)
const LF = createdIndex(rF, 'Loan')
cx.rec('76', 'LoanSet 10 XRP + origination 0.1 + service 0.01 + late 0.05 (mgmt fee 10000)', '', rF)
{
  const after = { BW: await bal(BW.classicAddress), O: await bal(O.classicAddress), vault: await vinfo(), pseudoBal: await bal(pseudo), pseudoBrokerBal: await bal(pseudoBroker) }
  const bAfter = await cx.entry(BF1)
  cx.note('76', `delta BW=+${after.BW - before.BW} (fee tx en sus) | delta O=${after.O - before.O} | delta pseudoVault=${after.pseudoBal - before.pseudoBal} | delta pseudoBroker=${after.pseudoBrokerBal - before.pseudoBrokerBal}`)
  cx.note('76', `vault: AssetsTotal ${before.vault.AssetsTotal}→${after.vault.AssetsTotal}, AssetsAvailable ${before.vault.AssetsAvailable}→${after.vault.AssetsAvailable} | Cover ${brokerObj.CoverAvailable}→${bAfter.CoverAvailable} DebtTotal=${bAfter.DebtTotal}`)
  if (LF) { const l = await cx.entry(LF); cx.note('76', `loan: ${JSON.stringify(l)}`) }
}

// ── 79/80 (préparé tôt) : remboursement anticipé intégral d'un prêt pas encore dû
{
  // le prêt du balayage 69.m120 n'est pas dû avant longtemps ; on rembourse LA (200s) plutôt
  const l = LA ? await cx.entry(LA) : null
  if (l) {
    const tvo = l.TotalValueOutstanding
    const r = await submit(cx.client, {
      TransactionType: 'LoanPay', Account: BW.classicAddress, LoanID: LA, Amount: String(tvo), Flags: 131072, // tfLoanFullPayment
    }, BW)
    cx.rec('79', `LoanPay intégral anticipé (TVO=${tvo}, tfLoanFullPayment)`, '', r)
    const after = await cx.entry(LA).catch(() => null)
    cx.rec('80', 'objet Loan après remboursement intégral', 'ledger_entry',
      after ? `objet TOUJOURS LÀ (Flags=${after.Flags}, TVO=${after.TotalValueOutstanding}, ClosePaymentPeriod=${after.ClosePaymentPeriod ?? '(absent)'})` : 'objet supprimé')
    if (after) {
      const rd = await submit(cx.client, { TransactionType: 'LoanDelete', Account: O.classicAddress, LoanID: LA }, O)
      cx.rec('80.del', 'LoanDelete sur prêt soldé', '', rd)
    }
  }
}

// ── 64 : multisig CPM\0 — SignerList 2-of-2 sur O, co-signature à deux
cx.log('\n=== 64. co-signature multisig (CPM\\0) ===')
cx.rec('64.sl', 'SignerListSet 2-of-2 sur O', '', await submit(cx.client, {
  TransactionType: 'SignerListSet', Account: O.classicAddress, SignerQuorum: 2,
  SignerEntries: [
    { SignerEntry: { Account: s1.classicAddress, SignerWeight: 1 } },
    { SignerEntry: { Account: s2.classicAddress, SignerWeight: 1 } },
  ],
}, O))
cx.rec('64.cpm', 'LoanSet co-signé multisig CPM\\0 (s1+s2)', '',
  await rawLoanSet({ ...baseTerms(), PrincipalRequested: XRP(1), PaymentInterval: 300, PaymentTotal: 1 }, BW, tx => {
    const signers = [s1, s2].map(s => ({
      Signer: { Account: s.classicAddress, SigningPubKey: s.publicKey, TxnSignature: counterpartySign(tx, s, s.classicAddress) },
    })).sort((a, b) => (a.Signer.Account < b.Signer.Account ? -1 : 1))
    tx.CounterpartySignature = { Signers: signers }
    return encode(tx)
  }))

// ── 77/78 : LoanPay — sous-paiement, tiers, échéance exacte, sur-paiement
{
  const l = LF ? await cx.entry(LF) : null
  if (l) {
    const due = Number(l.NextPaymentDueDate)
    const wait = due - rippleNow() + 5
    if (wait > 0) { cx.log(`attente 1re échéance de LF (${wait}s)…`); await sleep(wait * 1000) }
    cx.note('77', `champs du Loan à l'échéance: ${JSON.stringify(await cx.entry(LF))}`)

    cx.rec('77.under', 'LoanPay sous-paiement (0.5 XRP)', '', await submit(cx.client, {
      TransactionType: 'LoanPay', Account: BW.classicAddress, LoanID: LF, Amount: XRP(0.5),
    }, BW))
    cx.rec('78', 'LoanPay par un TIERS (X)', '', await submit(cx.client, {
      TransactionType: 'LoanPay', Account: X.classicAddress, LoanID: LF, Amount: XRP(6),
    }, X))

    // paiement "généreux" d'une échéance : on mesure ce qui est réellement pris
    const b0 = { BW: await bal(BW.classicAddress), pseudo: await bal(pseudo), pseudoBroker: await bal(pseudoBroker), O: await bal(O.classicAddress) }
    const rp = await submit(cx.client, {
      TransactionType: 'LoanPay', Account: BW.classicAddress, LoanID: LF, Amount: XRP(6),
    }, BW)
    cx.rec('77.pay', 'LoanPay 6 XRP (1re échéance)', '', rp)
    const b1 = { BW: await bal(BW.classicAddress), pseudo: await bal(pseudo), pseudoBroker: await bal(pseudoBroker), O: await bal(O.classicAddress) }
    const v1 = await vinfo()
    cx.note('73', `LoanPay: delta BW=${b1.BW - b0.BW} pseudoVault=${b1.pseudo - b0.pseudo} pseudoBroker=${b1.pseudoBroker - b0.pseudoBroker} O=${b1.O - b0.O} | AssetsTotal=${v1.AssetsTotal} AssetsAvailable=${v1.AssetsAvailable}`)
    cx.note('77', `loan après paiement: ${JSON.stringify(await cx.entry(LF).catch(() => 'supprimé'))}`)

    cx.rec('77.over', 'LoanPay sur-paiement avec tfLoanOverpayment', 'Amount=20 XRP Flags=65536', await submit(cx.client, {
      TransactionType: 'LoanPay', Account: BW.classicAddress, LoanID: LF, Amount: XRP(20), Flags: 65536,
    }, BW))
    cx.note('77', `loan après tentative de sur-paiement: ${JSON.stringify(await cx.entry(LF).catch(() => 'supprimé'))}`)
  }
}

// ── 72 : l'unité du taux, par comparaison LA vs LB (déjà lus) — voir notes
cx.note('72', 'comparer intérêt LA (200s) vs LB (400s) dans les notes ci-dessus : proportionnel au temps ⇒ taux annualisé ; identique ⇒ taux par période')

await cx.done()
