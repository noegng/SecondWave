import { num, safeDiv } from './num.mjs'

/**
 * NAV par part : (AssetsTotal − LossUnrealized) / SharesTotal.
 * Redeem XLS-65 : Δassets = Δshares × (AssetsTotal − LossUnrealized) / SharesTotal.
 */
export function navPerShare(vault) {
  const shares = num(vault?.sharesOutstanding)
  if (shares <= 0) return 0
  const assets = num(vault?.assetsTotal) - num(vault?.lossUnrealized)
  return Math.max(0, assets) / shares
}

export function redeemAssets(vault, shares) {
  return navPerShare(vault) * num(shares)
}

export function liquidityRatio(vault) {
  return safeDiv(vault?.assetsAvailable, vault?.assetsTotal)
}
