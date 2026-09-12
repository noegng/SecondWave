import { RatingBands, ScoreWeights } from '@secondwave/core'
import { EPSILON, clamp100, num, safeDiv } from './num.mjs'
import { isLatentDelinquent, isNpl, tenthBpsToRatio } from './protocol.mjs'
import { liquidityRatio } from './nav.mjs'

export function ratingFromScore(score) {
  for (const [letter, floor] of RatingBands) {
    if (score >= floor) return letter
  }
  return 'D'
}

function flcrScore(broker) {
  const debt = num(broker?.debtTotal)
  const cover = num(broker?.coverAvailable)
  if (debt < EPSILON) {
    // DebtTotal = 0 : le broker peut retirer 100 % du cover. Pas un AAA gratuit.
    return cover > 0 ? 40 : 50
  }
  const required = debt * tenthBpsToRatio(broker?.coverRateMinimum)
  if (required < EPSILON) return clamp100(safeDiv(cover, debt) * 100)
  return clamp100((cover / required) * 100)
}

function nplScore(loans) {
  const issued = loans.length
  if (issued === 0) return 100
  const bad = loans.filter(isNpl).length
  return clamp100((1 - bad / issued) * 100)
}

function concentrationScore(broker, loans) {
  const debt = num(broker?.debtTotal)
  if (debt < EPSILON || loans.length === 0) return 100
  const largest = Math.max(0, ...loans.map((l) => num(l.principalOutstanding)))
  return clamp100((1 - largest / debt) * 100)
}

/**
 * @param {object} input
 * @param {import('@secondwave/core').LoanBrokerSnapshot} input.broker
 * @param {import('@secondwave/core').VaultSnapshot} input.vault
 * @param {import('@secondwave/core').LoanSnapshot[]} [input.loans]
 * @param {number} [input.nowRipple]
 */
export function scoreBroker({ broker, vault, loans = [], nowRipple = 0 }) {
  const flcr = flcrScore(broker)
  const npl = nplScore(loans)
  const concentration = concentrationScore(broker, loans)
  const liquidity = clamp100(liquidityRatio(vault) * 100)
  const did = broker?.didVerified ? 100 : 0

  const riskScore = clamp100(
    ScoreWeights.flcr * flcr +
      ScoreWeights.npl * npl +
      ScoreWeights.concentration * concentration +
      ScoreWeights.liquidity * liquidity +
      ScoreWeights.did * did,
  )

  const latent = loans.filter((l) => isLatentDelinquent(l, nowRipple)).length
  const nplCount = loans.filter(isNpl).length

  return {
    riskScore: Math.round(riskScore * 10) / 10,
    rating: ratingFromScore(riskScore),
    components: {
      flcr: Math.round(flcr * 10) / 10,
      npl: Math.round(npl * 10) / 10,
      concentration: Math.round(concentration * 10) / 10,
      liquidity: Math.round(liquidity * 10) / 10,
      did,
    },
    raw: {
      coverAvailable: num(broker?.coverAvailable),
      debtTotal: num(broker?.debtTotal),
      flcrRatio: safeDiv(broker?.coverAvailable, broker?.debtTotal),
      nplRatio: loans.length ? nplCount / loans.length : 0,
      largestLoan: loans.length
        ? Math.max(0, ...loans.map((l) => num(l.principalOutstanding)))
        : 0,
      loansIssued: loans.length,
      latentDelinquent: latent,
    },
  }
}
