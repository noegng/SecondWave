import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { analyzeOffer } from '../src/index.mjs'
import { stressDefault } from '../src/stress.mjs'
import {
  healthyBroker,
  healthyLoans,
  healthyVault,
  nowRipple,
} from './fixtures.mjs'

describe('stressDefault', () => {
  it('fait baisser la NAV quand le cover protocolaire est trop petit', () => {
    const s = stressDefault({
      vault: healthyVault,
      broker: healthyBroker,
      loans: healthyLoans,
      defaultRate: 1,
    })
    assert.ok(s.vaultLossTotal > 0)
    assert.ok(s.navAfter < s.navBefore)
    assert.ok(s.navDrawdown > 0)
    assert.ok(s.coveredTotal < s.vaultLossTotal)
  })

  it('analyzeOffer assemble score + yield + classification', () => {
    const report = analyzeOffer({
      vault: healthyVault,
      broker: healthyBroker,
      loans: healthyLoans,
      offer: { shares: 1000, discount: 0.03 },
      nowRipple,
      stressRate: 0.5,
    })
    assert.ok(report.score.rating)
    assert.ok(report.yield.impliedApy > 0)
    assert.equal(report.classification.kind, 'liquidity')
    assert.ok(report.stress.navDrawdown >= 0)
  })
})
