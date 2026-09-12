import { num } from './num.mjs'
import { isLatentDelinquent, isNpl, tenthBpsToRatio } from './protocol.mjs'
import { navPerShare } from './nav.mjs'

export const DiscountKind = Object.freeze({
  Liquidity: 'liquidity',
  Distress: 'distress',
  Fair: 'fair',
})

/**
 * Distingue une décote de liquidité (opportunité : capital enfermé,
 * vault sain) d'une décote de détresse (piège : NAV pas encore sale
 * mais le risque a déjà empiré).
 *
 * Signaux de détresse — chacun suffit à basculer si le discount > 0 :
 * NPL, LossUnrealized, FLCR sous le minimum protocolaire, retard latent.
 */
export function classifyDiscount({ vault, broker, loans = [], offer, nowRipple = 0 }) {
  const reasons = []
  const npl = loans.filter(isNpl).length
  if (npl > 0) reasons.push(`${npl} prêt(s) impaired/default`)

  if (num(vault?.lossUnrealized) > 0) {
    reasons.push(`LossUnrealized = ${vault.lossUnrealized}`)
  }

  const debt = num(broker?.debtTotal)
  const required = debt * tenthBpsToRatio(broker?.coverRateMinimum)
  if (debt > 0 && num(broker?.coverAvailable) < required) {
    reasons.push('cover sous CoverRateMinimum')
  }

  const latent = loans.filter((l) => isLatentDelinquent(l, nowRipple)).length
  if (latent > 0) {
    reasons.push(
      `${latent} prêt(s) en retard latent (NAV encore intacte — le broker n'a pas impair)`,
    )
  }

  const discount = num(offer?.discount)
  const nav = navPerShare(vault)
  const kind =
    reasons.length > 0
      ? DiscountKind.Distress
      : discount > 0
        ? DiscountKind.Liquidity
        : DiscountKind.Fair

  return {
    kind,
    reasons,
    discount,
    nav,
    headline:
      kind === DiscountKind.Distress
        ? 'Décote de détresse — le prix bas reflète un risque déjà présent'
        : kind === DiscountKind.Liquidity
          ? 'Décote de liquidité — le capital est enfermé, le vault est sain'
          : 'Prix proche de la NAV — pas de décote matérielle',
  }
}
