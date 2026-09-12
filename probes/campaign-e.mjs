// Campagne E — LoanBroker et first-loss capital (50-62).
// 50 (open-ended → tecNO_PERMISSION) déjà confirmé en B/25.bset.
// 53 (rates 0/0 acceptés, conséquences) déjà mesuré en G (défaut à cover nul).
// Hypothèse d'unité issue de G : CoverRate en 1/1 000 000 (50000 ⇒ 5 %).
import {
  startCampaign, vaultCreate, depositTx,
  submit, safeLoanSet, createdIndex, rippleNow, sleep, XRP, hex,
} from './_lib.mjs'

const cx = await startCampaign('e')
const { O, D, BW } = await cx.fundMany(['O', 'D', 'BW'])

const sub = rippleNow() + 120
const red = sub + 600
const V = await vaultCreate(cx.client, O, {
  Asset: { currency: 'XRP' }, AssetsMaximum: '0', VaultKind: 1,
  SubscriptionDate: sub, RedemptionDate: red, WithdrawalPolicy: 1,
})
cx.rec('E0', 'VaultCreate', '', V)
cx.rec('E0.dep', 'D dépose 60 XRP', '', await submit(cx.client, depositTx(D, V.vaultId, XRP(60)), D))
cx.saveState({ V: V.vaultId, mptId: V.mptId, sub, red })

const mkB = (fields) => submit(cx.client, {
  TransactionType: 'LoanBrokerSet', Account: O.classicAddress, VaultID: V.vaultId,
  DebtMaximum: '0', ManagementFeeRate: 0, ...fields,
}, O)

// ── 51/52 : un seul des deux CoverRate non nul
cx.rec('51', 'CoverRateMinimum 10000, CoverRateLiquidation 0', '', await mkB({ CoverRateMinimum: 10000, CoverRateLiquidation: 0 }))
cx.rec('52', 'CoverRateMinimum 0, CoverRateLiquidation 50000', '', await mkB({ CoverRateMinimum: 0, CoverRateLiquidation: 50000 }))

// ── 59 : bornes du ManagementFeeRate
cx.rec('59.max', 'ManagementFeeRate 100000', '', await mkB({ CoverRateMinimum: 0, CoverRateLiquidation: 0, ManagementFeeRate: 100000 }))
cx.rec('59.over', 'ManagementFeeRate 100001', '', await mkB({ CoverRateMinimum: 0, CoverRateLiquidation: 0, ManagementFeeRate: 100001 }))

// ── décor : B_a (rates classiques) et B_u (rates max pour l'unité)
const ra = await mkB({ CoverRateMinimum: 10000, CoverRateLiquidation: 50000 })
const B_a = createdIndex(ra, 'LoanBroker')
cx.rec('E0.Ba', 'broker B_a 10000/50000', '', ra)
cx.rec('E0.Ba.cover', 'CoverDeposit 2 XRP', '', await submit(cx.client, {
  TransactionType: 'LoanBrokerCoverDeposit', Account: O.classicAddress, LoanBrokerID: B_a, Amount: XRP(2),
}, O))
const ru = await mkB({ CoverRateMinimum: 100000, CoverRateLiquidation: 100000 })
const B_u = createdIndex(ru, 'LoanBroker')
cx.rec('E0.Bu', 'broker B_u 100000/100000', '', ru)
cx.rec('E0.Bu.cover', 'CoverDeposit 1 XRP', '', await submit(cx.client, {
  TransactionType: 'LoanBrokerCoverDeposit', Account: O.classicAddress, LoanBrokerID: B_u, Amount: XRP(1),
}, O))
const rz = await mkB({ CoverRateMinimum: 0, CoverRateLiquidation: 0 })
const B_z = createdIndex(rz, 'LoanBroker')
cx.rec('E0.Bz', 'broker B_z 0/0 (pour le partage de liquidité)', '', rz)

// ── 54 : modifier un broker existant
for (const [k, fields] of [
  ['coverMin', { LoanBrokerID: B_a, CoverRateMinimum: 20000 }],
  ['coverLiq', { LoanBrokerID: B_a, CoverRateLiquidation: 60000 }],
  ['debtMax', { LoanBrokerID: B_a, DebtMaximum: XRP(50) }],
  ['fee', { LoanBrokerID: B_a, ManagementFeeRate: 500 }],
  ['data', { LoanBrokerID: B_a, Data: hex('maj') }],
]) {
  const r = await submit(cx.client, {
    TransactionType: 'LoanBrokerSet', Account: O.classicAddress, ...fields,
  }, O)
  cx.rec(`54.${k}`, `LoanBrokerSet update ${k}`, JSON.stringify(fields), r)
}

// ── le trou de la matrice B : LoanSet VALIDE pendant la Subscription
cx.rec('B21.lset.S', 'LoanSet VALIDE en Subscription', '', await safeLoanSet(cx.client, {
  TransactionType: 'LoanSet', Account: BW.classicAddress, LoanBrokerID: B_a,
  PrincipalRequested: XRP(1), PaymentInterval: 120, PaymentTotal: 1, GracePeriod: 60, InterestRate: 0,
}, BW, O))

// ══ Investment ══
{
  const wait = sub - rippleNow() + 6
  if (wait > 0) { cx.log(`attente Investment (${wait}s)…`); await sleep(wait * 1000) }
}

// ── 55 : l'unité des CoverRate — B_u: min 100000, cover 1 XRP
//    si 1/1e6 (10%): plafond de dette = 10 XRP ; si 1/1e5 (100%): plafond = 1 XRP
cx.rec('55.10', 'LoanSet 10 XRP sur B_u (passe si unité=1/1e6)', '', await safeLoanSet(cx.client, {
  TransactionType: 'LoanSet', Account: BW.classicAddress, LoanBrokerID: B_u,
  PrincipalRequested: XRP(10), PaymentInterval: 300, PaymentTotal: 1, GracePeriod: 60, InterestRate: 0,
}, BW, O))
cx.rec('55.plus', 'LoanSet 0.1 XRP de plus sur B_u (doit buter sur le cover)', '', await safeLoanSet(cx.client, {
  TransactionType: 'LoanSet', Account: BW.classicAddress, LoanBrokerID: B_u,
  PrincipalRequested: XRP(0.1), PaymentInterval: 300, PaymentTotal: 1, GracePeriod: 60, InterestRate: 0,
}, BW, O))

// ── 56 : cover au-delà du nécessaire — un plafond ?
cx.rec('56', 'CoverDeposit 20 XRP de plus sur B_a (aucune dette)', '', await submit(cx.client, {
  TransactionType: 'LoanBrokerCoverDeposit', Account: O.classicAddress, LoanBrokerID: B_a, Amount: XRP(20),
}, O))

// ── 60 : deux brokers, une seule liquidité
cx.rec('60.a', 'LoanSet 35 XRP via B_a (AssetsAvailable ~50 après 55.10)', '', await safeLoanSet(cx.client, {
  TransactionType: 'LoanSet', Account: BW.classicAddress, LoanBrokerID: B_a,
  PrincipalRequested: XRP(35), PaymentInterval: 300, PaymentTotal: 1, GracePeriod: 60, InterestRate: 0,
}, BW, O))
cx.rec('60.b', 'LoanSet 30 XRP via B_z (le pool est-il partagé ?)', '', await safeLoanSet(cx.client, {
  TransactionType: 'LoanSet', Account: BW.classicAddress, LoanBrokerID: B_z,
  PrincipalRequested: XRP(30), PaymentInterval: 300, PaymentTotal: 1, GracePeriod: 60, InterestRate: 0,
}, BW, O))
{
  const v = await cx.request({ command: 'vault_info', vault_id: V.vaultId }).then(r => r.vault)
  cx.note('60', `après: AssetsTotal=${v.AssetsTotal ?? 0} AssetsAvailable=${v.AssetsAvailable ?? 0}`)
}

// ── 58 : plancher du cover avec dette en cours (B_a : dette 35, min 10000)
{
  const b = await cx.entry(B_a)
  cx.note('58', `B_a: CoverAvailable=${b.CoverAvailable} DebtTotal=${b.DebtTotal}`)
  const debt = BigInt(b.DebtTotal ?? 0)
  const cover = BigInt(b.CoverAvailable ?? 0)
  const floor1e6 = debt * 10000n / 1000000n     // si unité 1/1e6
  cx.rec('58.all', `CoverWithdraw TOTAL (${cover}) avec dette ${debt}`, '', await submit(cx.client, {
    TransactionType: 'LoanBrokerCoverWithdraw', Account: O.classicAddress, LoanBrokerID: B_a, Amount: String(cover),
  }, O))
  const toFloor = cover - floor1e6
  cx.rec('58.floor', `CoverWithdraw jusqu'au plancher supposé (${toFloor}, reste ${floor1e6})`, '', await submit(cx.client, {
    TransactionType: 'LoanBrokerCoverWithdraw', Account: O.classicAddress, LoanBrokerID: B_a, Amount: String(toFloor),
  }, O))
  cx.rec('58.one', 'CoverWithdraw 1 drop de plus', '', await submit(cx.client, {
    TransactionType: 'LoanBrokerCoverWithdraw', Account: O.classicAddress, LoanBrokerID: B_a, Amount: '1',
  }, O))
  const b2 = await cx.entry(B_a)
  cx.note('58', `après: CoverAvailable=${b2.CoverAvailable ?? 0} (plancher théorique 1/1e6: ${floor1e6})`)
}

// ── 57 : la course cover-withdraw vs LoanSet (piste sécurité)
//    broker B_r : cover 2 XRP, min 100000 (10% si 1/1e6). Un LoanSet de 15 XRP
//    exige 1.5 XRP de cover. On retire les 2 XRP et on soumet le LoanSet
//    dans la même fenêtre de ledger.
{
  const rr = await mkB({ CoverRateMinimum: 100000, CoverRateLiquidation: 100000 })
  const B_r = createdIndex(rr, 'LoanBroker')
  cx.rec('57.r', 'broker B_r 100000/100000 (course)', '', rr)
  await submit(cx.client, {
    TransactionType: 'LoanBrokerCoverDeposit', Account: O.classicAddress, LoanBrokerID: B_r, Amount: XRP(2),
  }, O)
  // les deux quasi simultanément : fire (sans attente) + safeLoanSet
  const fired = await cx.fire({
    TransactionType: 'LoanBrokerCoverWithdraw', Account: O.classicAddress, LoanBrokerID: B_r, Amount: XRP(2),
  }, O)
  const ls = await safeLoanSet(cx.client, {
    TransactionType: 'LoanSet', Account: BW.classicAddress, LoanBrokerID: B_r,
    PrincipalRequested: XRP(15), PaymentInterval: 200, PaymentTotal: 1, GracePeriod: 60, InterestRate: 0,
  }, BW, O)
  const wd = await cx.finalOf(fired.hash)
  cx.rec('57.race.wd', 'CoverWithdraw 100% tiré pendant le LoanSet', `prelim ${fired.engine}`, `${wd.result} (ledger ${wd.ledger})`)
  cx.rec('57.race.ls', 'LoanSet 15 XRP concurrent', '', ls, '', ls.hash ? `hash ${ls.hash.slice(0, 8)}` : '')
  const b = await cx.entry(B_r).catch(() => null)
  cx.note('57', `B_r après course: CoverAvailable=${b?.CoverAvailable ?? 0} DebtTotal=${b?.DebtTotal ?? 0}`)
}

// ── 62 : supprimer un broker avec prêts en cours
cx.rec('62', 'LoanBrokerDelete sur B_a (dette 35 XRP en cours)', '', await submit(cx.client, {
  TransactionType: 'LoanBrokerDelete', Account: O.classicAddress, LoanBrokerID: B_a,
}, O))

await cx.done()
