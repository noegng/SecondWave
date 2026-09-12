import { num } from './num.mjs'
import { tenthBpsToRatio } from './protocol.mjs'

/**
 * Formule First-Loss XLS-66 (rippled / spec).
 *
 * Le cover mobilisé n'est PAS `CoverAvailable` entier :
 *   DefaultCovered = min(
 *     DebtTotal × CoverRateMinimum × CoverRateLiquidation,
 *     DefaultAmount,
 *     CoverAvailable
 *   )
 * CoverRateLiquidation porte sur le *cover minimum*, pas sur DebtTotal.
 * Ex. min=10_000 (10 %) et liq=50_000 (50 %) → cap = 5 % de DebtTotal
 * → 95 % de la perte va aux déposants, même si CoverAvailable est plus grand.
 */
export function defaultCoverage(broker, loan) {
  const debtTotal = num(broker?.debtTotal)
  const coverAvailable = num(broker?.coverAvailable)
  const defaultAmount = Math.max(
    0,
    num(loan?.totalValueOutstanding) - num(loan?.managementFeeOutstanding),
  )
  const coverRateMin = tenthBpsToRatio(broker?.coverRateMinimum)
  const coverRateLiq = tenthBpsToRatio(broker?.coverRateLiquidation)
  const minimumCover = debtTotal * coverRateMin
  const protocolCap = minimumCover * coverRateLiq
  const covered = Math.min(protocolCap, defaultAmount, coverAvailable)
  const vaultLoss = Math.max(0, defaultAmount - covered)

  return {
    defaultAmount,
    minimumCover,
    protocolCap,
    covered,
    vaultLoss,
    depositorShare: defaultAmount > 0 ? vaultLoss / defaultAmount : 0,
    unusedCover: Math.max(0, coverAvailable - covered),
  }
}
