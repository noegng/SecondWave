import { num } from './num.mjs'
import { defaultCoverage } from './cover.mjs'
import { navPerShare } from './nav.mjs'

/**
 * Simule un défaut de `defaultRate` (0–1) sur le principal actif.
 * Applique la formule First-Loss prêt par prêt (plus gros d'abord),
 * puis propage VaultLoss dans LossUnrealized et recalcule la NAV.
 */
export function stressDefault({ vault, broker, loans = [], defaultRate = 0 }) {
  const rate = Math.min(1, Math.max(0, num(defaultRate)))
  const active = [...loans]
    .filter((l) => num(l.principalOutstanding) > 0)
    .sort((a, b) => num(b.principalOutstanding) - num(a.principalOutstanding))

  const target = active.reduce((s, l) => s + num(l.principalOutstanding), 0) * rate
  let remaining = target
  let coverLeft = num(broker?.coverAvailable)
  let coveredTotal = 0
  let vaultLossTotal = 0
  const hits = []

  for (const loan of active) {
    if (remaining <= 0) break
    const slice = Math.min(num(loan.principalOutstanding), remaining)
    const scaled = {
      ...loan,
      totalValueOutstanding:
        num(loan.totalValueOutstanding) *
        (slice / Math.max(num(loan.principalOutstanding), 1e-12)),
      managementFeeOutstanding:
        num(loan.managementFeeOutstanding) *
        (slice / Math.max(num(loan.principalOutstanding), 1e-12)),
    }
    const coverage = defaultCoverage({ ...broker, coverAvailable: coverLeft }, scaled)
    coverLeft = Math.max(0, coverLeft - coverage.covered)
    coveredTotal += coverage.covered
    vaultLossTotal += coverage.vaultLoss
    remaining -= slice
    hits.push({ loanId: loan.loanId ?? loan.loanSequence, ...coverage, slice })
  }

  const stressedVault = {
    ...vault,
    lossUnrealized: num(vault?.lossUnrealized) + vaultLossTotal,
    assetsAvailable: Math.max(0, num(vault?.assetsAvailable) - vaultLossTotal),
  }
  const navBefore = navPerShare(vault)
  const navAfter = navPerShare(stressedVault)

  return {
    defaultRate: rate,
    targetedPrincipal: target,
    coveredTotal,
    vaultLossTotal,
    unusedCover: coverLeft,
    navBefore,
    navAfter,
    navDrawdown: navBefore > 0 ? (navBefore - navAfter) / navBefore : 0,
    hits,
  }
}
