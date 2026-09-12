import { num } from './num.mjs'
import { navPerShare } from './nav.mjs'
import { daysUntil, tenthBpsToRatio } from './protocol.mjs'

/**
 * Prix d'une offre : `price` explicite, sinon NAV × parts × (1 − discount).
 */
export function offerPrice(vault, offer) {
  if (offer?.price != null && offer.price !== '') return num(offer.price)
  const nav = navPerShare(vault)
  return nav * num(offer?.shares) * (1 - num(offer?.discount))
}

/**
 * Valeur de rachat estimée à RedemptionDate.
 * Premier ordre : NAV actuelle × parts.
 * Si un prêt actif reste, on ajoute la quote-part des intérêts nets
 * de ManagementFeeRate (approximation : intérêts restants ≈
 * TotalValueOutstanding − PrincipalOutstanding).
 */
export function estimatedMaturityValue(vault, broker, loans, shares) {
  const navValue = navPerShare(vault) * num(shares)
  const outstanding = num(vault?.sharesOutstanding)
  if (outstanding <= 0) return navValue

  const feeRate = tenthBpsToRatio(broker?.managementFeeRate)
  let remainingInterest = 0
  for (const loan of loans ?? []) {
    remainingInterest += Math.max(
      0,
      num(loan.totalValueOutstanding) - num(loan.principalOutstanding),
    )
  }
  const depositorShare = num(shares) / outstanding
  return navValue + depositorShare * remainingInterest * (1 - feeRate)
}

/**
 * Implied APY annualisé jusqu'à RedemptionDate.
 * `((valeur_maturité / prix) − 1) × 365 / jours_restants`
 */
export function impliedApy(vault, offer, broker, loans, nowRipple) {
  const price = offerPrice(vault, offer)
  const days = daysUntil(vault?.redemptionDate, nowRipple)
  if (price <= 0 || days <= 0) {
    return { impliedApy: null, price, daysRemaining: days, maturityValue: 0 }
  }
  const maturityValue = estimatedMaturityValue(vault, broker, loans, offer.shares)
  const apy = (maturityValue / price - 1) * (365 / days)
  return {
    impliedApy: apy,
    price,
    daysRemaining: days,
    maturityValue,
  }
}
