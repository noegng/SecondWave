/**
 * fixtures/test-vault-lifecycle.mjs — test d'INTÉGRATION, lancé à la main.
 *
 *   npm run test:integration      (nécessite le Devnet + le faucet)
 *
 * Rejoue un cycle complet closed-ended sur le Devnet et vérifie les codes de
 * retour attendus, y compris que la validation LOCALE attrape la règle non
 * documentée (60 ≤ GracePeriod ≤ PaymentInterval) AVANT tout envoi réseau.
 *
 * ⚠️ Ce script prend ~5 min (attentes de phase). Il est SÉPARÉ de `npm test`,
 *    qui, lui, tourne hors ligne.
 */
import { connect, fundAccount, readVaultGraph, sleep, rippleNow } from '@secondwave/core'
import {
  VaultError, createVault, deposit, createBroker, coverDeposit, createLoan,
  payLoan, impair, declareDefault,
} from '@secondwave/vault'

const XRP = n => String(Math.round(n * 1_000_000))
let fails = 0
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? '✅' : '❌'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) fails++
}

// ── 0. La validation locale attrape la règle non documentée, sans réseau ──
console.log('\n━━━ 0. Validation locale (hors réseau) ━━━')
try {
  // GracePeriod 30 < 60 : doit jeter VaultError AVANT tout appel.
  await createLoan(null, { classicAddress: 'r' }, { classicAddress: 'r' }, 'B',
    { principal: 1, paymentInterval: 120, paymentTotal: 2, gracePeriod: 30 })
  check('GracePeriod:30 rejeté localement', false, 'aucune erreur levée')
} catch (e) {
  check('GracePeriod:30 rejeté localement', e instanceof VaultError && e.code === 'GRACE_PERIOD_RANGE', e.code)
  console.log(`     message : ${e.message}`)
}

// ── Le cycle réel ──
const c = await connect()
console.log('\n━━━ 1. Décor (faucet + vault + dépôt + broker + cover) ━━━')
const owner = await fundAccount()
const borrower = await fundAccount()
await sleep(5000)

const v = await createVault(c, owner, { subscriptionIn: 90, investmentFor: 700 })
check('VaultCreate closed-ended', v.ok, v.result)
await deposit(c, owner, v.vaultId, XRP(40))
const b = await createBroker(c, owner, v.vaultId, { debtMaximum: XRP(20), cover: 5,
  coverRateMinimum: 10000, coverRateLiquidation: 50000 })
check('LoanBrokerSet', Boolean(b.brokerId), b.result)
await coverDeposit(c, owner, b.brokerId, XRP(5))

console.log('\n━━━ 2. Attente de la phase Investment ━━━')
const wait = v.subscriptionDate - rippleNow() + 10
if (wait > 0) { console.log(`  ${wait}s…`); await sleep(wait * 1000) }

console.log('\n━━━ 3. LoanSet (fix CPT via core.counterpartySign) ━━━')
const loan = await createLoan(c, borrower, owner, b.brokerId, {
  principal: 6, paymentInterval: 60, paymentTotal: 2, gracePeriod: 60, interestRate: 50000,
  redemptionDate: v.redemptionDate,
})
check('LoanSet co-signé accepté', loan.ok, loan.result)
if (!loan.loanId) { console.log(`\n❌ pas de prêt (${loan.result} ${loan.message ?? ''}) — arrêt.`); await c.disconnect(); process.exit(1) }

console.log('\n━━━ 4. LoanPay (1re échéance) ━━━')
await sleep(62000)
const pay = await payLoan(c, borrower, loan.loanId, XRP(4))
check('LoanPay', pay.ok, pay.result)

console.log('\n━━━ 5. Impairment puis défaut ━━━')
const g1 = await readVaultGraph(c, v.vaultId)
const l = g1.brokers[0].loans[0]
const target = Number(l.NextPaymentDueDate) + Number(l.GracePeriod) + 8
let d = target - rippleNow()
if (d > 0) { console.log(`  attente ${d}s (échéance + grâce)…`); await sleep(d * 1000) }
const imp = await impair(c, owner, loan.loanId)
check('tfLoanImpair accepté', imp.ok, imp.result)
const g2 = await readVaultGraph(c, v.vaultId)
check('LossUnrealized reflété dans les métriques', Number(g2.metrics.lossUnrealized) > 0,
  `LossUnrealized=${g2.metrics.lossUnrealized}, NAV prudente ${g2.metrics.navPrudentPerShare}`)
const def = await declareDefault(c, owner, loan.loanId)
check('tfLoanDefault accepté', def.ok, def.result)
const g3 = await readVaultGraph(c, v.vaultId)
console.log(`  après défaut : AssetsTotal=${g3.metrics.assetsTotal} NAV/part=${g3.metrics.navPerShare}`)

console.log(`\n${fails === 0 ? '✅ cycle complet vérifié.' : `❌ ${fails} vérification(s) en échec.`}\n`)
await c.disconnect()
process.exit(fails === 0 ? 0 : 1)
