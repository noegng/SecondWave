/**
 * Tests hors ligne des dérivations pour l'analyste (Lot 2).
 *   node --test packages/core/test
 * Objets ledger reconstitués à la main d'après les formes réelles observées
 * (probes/out/*.json) : aucun réseau, résultat déterministe.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  phaseInfo, vaultMetrics, brokerMetrics, loanMetrics, concentrationHHI,
} from '../src/analytics.mjs'

const vault = {
  VaultKind: 1, SubscriptionDate: 100, RedemptionDate: 400,
  AssetsTotal: '30000000', AssetsAvailable: '12000000', LossUnrealized: '4000000',
  Asset: { currency: 'XRP' }, shares: { OutstandingAmount: '30000000', Flags: 56 },
}

test('phaseInfo : Investment au milieu, avec temps restant', () => {
  const p = phaseInfo(vault, 200)
  assert.equal(p.phase, 'Investment')
  assert.equal(p.next, 'Redemption')
  assert.equal(p.endsAt, '400')
  assert.equal(p.secondsRemaining, '200')
})

test('phaseInfo : Subscription puis Redemption aux extrêmes', () => {
  assert.equal(phaseInfo(vault, 50).phase, 'Subscription')
  const r = phaseInfo(vault, 500)
  assert.equal(r.phase, 'Redemption')
  assert.equal(r.secondsRemaining, null)
})

test('phaseInfo : open-ended → pas de phase', () => {
  assert.equal(phaseInfo({ VaultKind: 0 }).phase, null)
})

test('vaultMetrics : NAV, utilisation, NAV prudente', () => {
  const m = vaultMetrics(vault)
  assert.equal(m.assetsLent, '18000000')          // 30 − 12
  assert.equal(m.navPerShare, 1)                   // 1:1
  assert.equal(m.utilisation, 0.6)                 // 18/30
  assert.equal(m.navPrudentPerShare, 0.866666)     // (30−4)/30
  assert.equal(typeof m.assetsTotal, 'string')     // entiers en string
})

test('brokerMetrics : broker à cover 0/0 = signal rouge', () => {
  const b = brokerMetrics({ CoverRateMinimum: 0, CoverRateLiquidation: 0, CoverAvailable: '0', DebtTotal: '6000000', Owner: 'rOWNER' })
  assert.equal(b.noCover, true)
})

test('brokerMetrics : cover 100 % retirable à DebtTotal 0 [E-57]', () => {
  const b = brokerMetrics({ CoverRateMinimum: 10000, CoverRateLiquidation: 50000, CoverAvailable: '5000000', DebtTotal: '0', Owner: 'rX' })
  assert.equal(b.noCover, false)
  assert.equal(b.coverWithdrawable, '5000000')
  assert.equal(b.coverWithdrawableIsEstimate, false)
  assert.equal(b.coverRateMinimumPct, 10)
  assert.equal(b.coverRateLiquidationPct, 50)
})

test('brokerMetrics : cover exigé = dette × min/1e5, retrait borné', () => {
  const b = brokerMetrics({ CoverRateMinimum: 10000, CoverRateLiquidation: 50000, CoverAvailable: '2000000', DebtTotal: '10000000', Owner: 'rX' })
  assert.equal(b.coverRequired, '1000000')         // 10 XRP × 10 %
  assert.equal(b.coverWithdrawable, '1000000')     // 2 − 1
  assert.equal(b.coverWithdrawableIsEstimate, true)
})

test('loanMetrics : auto-prêt détecté', () => {
  const l = loanMetrics(
    { Borrower: 'rOWNER', Flags: 0, PrincipalOutstanding: '6000000', TotalValueOutstanding: '6000006', NextPaymentDueDate: 120, GracePeriod: 60 },
    { at: 150, brokerOwner: 'rOWNER', vaultAssetsTotal: '30000000' })
  assert.equal(l.selfLoan, true)
  assert.equal(l.weight, 0.2)                       // 6/30
})

test('loanMetrics : défaillable calculé (non déclaré) [G-89]', () => {
  const l = loanMetrics(
    { Borrower: 'rB', Flags: 0, PrincipalOutstanding: '5000000', TotalValueOutstanding: '5000000', NextPaymentDueDate: 120, GracePeriod: 60 },
    { at: 300 })                                     // 300 > 120 + 60
  assert.equal(l.status, 'défaillable')
  assert.equal(l.defaillable, true)
  assert.equal(l.secondsLate, '180')
})

test('loanMetrics : statuts sain / en grâce / impairé / en défaut / soldé', () => {
  const base = { Borrower: 'rB', PrincipalOutstanding: '1000000', TotalValueOutstanding: '1000000', NextPaymentDueDate: 200, GracePeriod: 60 }
  assert.equal(loanMetrics({ ...base, Flags: 0 }, { at: 150 }).status, 'sain')
  assert.equal(loanMetrics({ ...base, Flags: 0 }, { at: 230 }).status, 'en grâce')
  assert.equal(loanMetrics({ ...base, Flags: 0x00020000 }, { at: 150 }).status, 'impairé')
  assert.equal(loanMetrics({ ...base, Flags: 0x00010000 }, { at: 150 }).status, 'en défaut')
  assert.equal(loanMetrics({ Borrower: 'rB', Flags: 0, PrincipalOutstanding: '0' }, { at: 150 }).status, 'soldé')
})

test('concentrationHHI : monopole vs équilibré', () => {
  assert.equal(concentrationHHI([{ shares: '100' }], '100'), 10000)                       // monopole
  assert.equal(concentrationHHI([{ shares: '50' }, { shares: '50' }], '100'), 5000)       // 2 égaux
  assert.equal(concentrationHHI([], '0'), 0)
})
