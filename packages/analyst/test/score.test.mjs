import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { ratingFromScore, scoreBroker } from '../src/score.mjs'
import {
  crisisBroker,
  crisisLoans,
  crisisVault,
  healthyBroker,
  healthyLoans,
  healthyVault,
  nowRipple,
  speculativeBroker,
  speculativeLoans,
  speculativeVault,
} from './fixtures.mjs'

describe('scoreBroker', () => {
  it('note un courtier sain au-dessus de A', () => {
    const s = scoreBroker({
      broker: healthyBroker,
      vault: healthyVault,
      loans: healthyLoans,
      nowRipple,
    })
    assert.ok(s.riskScore >= 65, `score=${s.riskScore}`)
    assert.match(s.rating, /^(AAA|AA|A)$/)
    assert.equal(s.raw.nplRatio, 0)
    assert.equal(s.raw.latentDelinquent, 0)
  })

  it('pénalise concentration + cover juste au minimum', () => {
    const s = scoreBroker({
      broker: speculativeBroker,
      vault: speculativeVault,
      loans: speculativeLoans,
      nowRipple,
    })
    assert.ok(s.riskScore < 65, `score=${s.riskScore}`)
    assert.ok(s.components.concentration < 50)
  })

  it('classe un courtier en crise en bas de grille', () => {
    const s = scoreBroker({
      broker: crisisBroker,
      vault: crisisVault,
      loans: crisisLoans,
      nowRipple,
    })
    assert.ok(s.riskScore < 45, `score=${s.riskScore}`)
    assert.ok(['BB', 'B', 'CCC', 'CC', 'C', 'D'].includes(s.rating))
    assert.equal(s.raw.nplRatio, 1)
  })

  it('mappe les bandes AAA→D', () => {
    assert.equal(ratingFromScore(90), 'AAA')
    assert.equal(ratingFromScore(85), 'AAA')
    assert.equal(ratingFromScore(75), 'AA')
    assert.equal(ratingFromScore(4.9), 'D')
  })
})
