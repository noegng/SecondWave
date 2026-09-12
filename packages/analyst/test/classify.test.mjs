import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { classifyDiscount, DiscountKind } from '../src/classify.mjs'
import { vaultPhase } from '../src/protocol.mjs'
import { VaultPhase } from '@secondwave/core'
import {
  crisisBroker,
  crisisLoans,
  crisisVault,
  healthyBroker,
  healthyLoans,
  healthyVault,
  latentLoans,
  nowRipple,
} from './fixtures.mjs'

describe('classifyDiscount', () => {
  it('lit une décote saine comme liquidité', () => {
    const c = classifyDiscount({
      vault: healthyVault,
      broker: healthyBroker,
      loans: healthyLoans,
      offer: { shares: 1000, discount: 0.03 },
      nowRipple,
    })
    assert.equal(c.kind, DiscountKind.Liquidity)
    assert.equal(c.reasons.length, 0)
  })

  it('lit NPL + LossUnrealized comme détresse', () => {
    const c = classifyDiscount({
      vault: crisisVault,
      broker: crisisBroker,
      loans: crisisLoans,
      offer: { shares: 1000, discount: 0.2 },
      nowRipple,
    })
    assert.equal(c.kind, DiscountKind.Distress)
    assert.ok(c.reasons.length >= 2)
  })

  it('détecte le retard latent avant que la NAV bouge', () => {
    const c = classifyDiscount({
      vault: healthyVault,
      broker: healthyBroker,
      loans: latentLoans,
      offer: { shares: 1000, discount: 0.08 },
      nowRipple,
    })
    assert.equal(c.kind, DiscountKind.Distress)
    assert.ok(c.reasons.some((r) => /latent/.test(r)))
  })
})

describe('vaultPhase', () => {
  it('Investment entre SubscriptionDate et RedemptionDate', () => {
    assert.equal(vaultPhase(healthyVault, nowRipple), VaultPhase.Investment)
  })

  it('Subscription inclusive à SubscriptionDate', () => {
    assert.equal(
      vaultPhase(healthyVault, healthyVault.subscriptionDate),
      VaultPhase.Subscription,
    )
  })
})
