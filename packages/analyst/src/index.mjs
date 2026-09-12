export { num, safeDiv, clamp01, clamp100 } from './num.mjs'
export {
  tenthBpsToRatio,
  ratioToTenthBps,
  hasFlag,
  isImpaired,
  isDefaulted,
  isNpl,
  isLatentDelinquent,
  vaultPhase,
  daysUntil,
} from './protocol.mjs'
export { navPerShare, redeemAssets, liquidityRatio } from './nav.mjs'
export { defaultCoverage } from './cover.mjs'
export { scoreBroker, ratingFromScore } from './score.mjs'
export { offerPrice, estimatedMaturityValue, impliedApy } from './yield.mjs'
export { classifyDiscount, DiscountKind } from './classify.mjs'
export { stressDefault } from './stress.mjs'

import { scoreBroker } from './score.mjs'
import { impliedApy } from './yield.mjs'
import { classifyDiscount } from './classify.mjs'
import { stressDefault } from './stress.mjs'
import { navPerShare } from './nav.mjs'
import { vaultPhase } from './protocol.mjs'

/**
 * Rapport unique pour une offre SecondWave : note courtier, NAV,
 * implied APY, et verdict liquidité vs détresse.
 */
export function analyzeOffer({ vault, broker, loans = [], offer, nowRipple = 0, stressRate = 0 }) {
  const score = scoreBroker({ broker, vault, loans, nowRipple })
  const yield_ = impliedApy(vault, offer, broker, loans, nowRipple)
  const classification = classifyDiscount({ vault, broker, loans, offer, nowRipple })
  const stress = stressRate > 0 ? stressDefault({ vault, broker, loans, defaultRate: stressRate }) : null

  return {
    phase: vaultPhase(vault, nowRipple),
    nav: navPerShare(vault),
    score,
    yield: yield_,
    classification,
    stress,
  }
}
