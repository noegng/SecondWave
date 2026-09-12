import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { impliedApy, offerPrice } from '../src/yield.mjs'
import { navPerShare } from '../src/nav.mjs'
import { healthyBroker, healthyLoans, healthyVault, nowRipple } from './fixtures.mjs'

describe('impliedApy', () => {
  it('prix = NAV × parts × (1 − discount)', () => {
    const nav = navPerShare(healthyVault)
    assert.equal(nav, 1)
    assert.equal(offerPrice(healthyVault, { shares: 1000, discount: 0.03 }), 970)
  })

  it('une décote relève l’APY implicite', () => {
    const cheap = impliedApy(
      healthyVault,
      { shares: 1000, discount: 0.1 },
      healthyBroker,
      healthyLoans,
      nowRipple,
    )
    const par = impliedApy(
      healthyVault,
      { shares: 1000, discount: 0 },
      healthyBroker,
      healthyLoans,
      nowRipple,
    )
    assert.ok(cheap.impliedApy > par.impliedApy)
    assert.ok(cheap.daysRemaining > 0)
  })

  it('retourne null si RedemptionDate est passée', () => {
    const r = impliedApy(
      { ...healthyVault, redemptionDate: nowRipple - 1 },
      { shares: 1000, discount: 0.05 },
      healthyBroker,
      [],
      nowRipple,
    )
    assert.equal(r.impliedApy, null)
  })
})
