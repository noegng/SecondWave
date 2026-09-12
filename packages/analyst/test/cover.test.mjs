import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { defaultCoverage } from '../src/cover.mjs'
import { crisisBroker, crisisLoans } from './fixtures.mjs'

describe('defaultCoverage', () => {
  it('socialise 95 % quand min=10 % et liquidation=50 %', () => {
    const broker = {
      debtTotal: '10000',
      coverAvailable: '5000',
      coverRateMinimum: 10_000,      // 10 %
      coverRateLiquidation: 50_000,  // 50 % du cover min → 5 % de DebtTotal
    }
    const loan = { totalValueOutstanding: '10000', managementFeeOutstanding: '0' }
    const c = defaultCoverage(broker, loan)
    assert.equal(c.protocolCap, 500)
    assert.equal(c.covered, 500)
    assert.equal(c.vaultLoss, 9500)
    assert.equal(c.depositorShare, 0.95)
    assert.equal(c.unusedCover, 4500)
  })

  it('ne prend pas plus que CoverAvailable', () => {
    const c = defaultCoverage(
      { ...crisisBroker, coverAvailable: '10' },
      crisisLoans[0],
    )
    // protocolCap = 6000 × 10 % × 5 % = 30, mais cover = 10
    assert.equal(c.covered, 10)
  })

  it('retire les frais de gestion du DefaultAmount', () => {
    const c = defaultCoverage(
      { debtTotal: '1000', coverAvailable: '1000', coverRateMinimum: 100_000, coverRateLiquidation: 100_000 },
      { totalValueOutstanding: '100', managementFeeOutstanding: '20' },
    )
    assert.equal(c.defaultAmount, 80)
    assert.equal(c.covered, 80)
    assert.equal(c.vaultLoss, 0)
  })
})
