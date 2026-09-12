import { analyzeOffer } from './analyze.mjs'
import { adaptCase } from './adapt.mjs'
import { tenthBpsToRatio } from './protocol.mjs'

function pct(value, digits = 1) {
  if (value == null || Number.isNaN(value)) return 'n/a'
  return `${(value * 100).toFixed(digits)} %`
}

function apy(value) {
  if (value == null || Number.isNaN(value)) return 'n/a'
  return `${(value * 100).toFixed(1)} %`
}

/**
 * Rapport terminal d'une offre. `input` peut être du JSON ledger brut
 * (PascalCase) ou nos snapshots camelCase.
 */
export function formatReport(input, title = 'Offre') {
  const args = adaptCase(input)
  const r = analyzeOffer(args)
  const { score, yield: y, classification: c, stress, nav, phase } = r
  const lines = [
    `━━ ${title} ━━  ${c.kind.toUpperCase()}  ·  ${score.rating} (${score.riskScore})  ·  phase ${phase}`,
    `  ${c.headline}`,
    `  NAV ${nav.toFixed(4)}   prix ${y.price.toFixed(2)}   maturité ~${y.maturityValue.toFixed(2)}   APY ${apy(y.impliedApy)}   ${y.daysRemaining.toFixed(1)} j`,
    `  FLCR ${score.components.flcr}  NPL ${score.components.npl}  conc. ${score.components.concentration}  liq. ${score.components.liquidity}  DID ${score.components.did}`,
    `  cover ${score.raw.coverAvailable} / debt ${score.raw.debtTotal}  (ratio ${pct(score.raw.flcrRatio)})   latent ${score.raw.latentDelinquent}`,
  ]
  if (c.reasons.length) lines.push(`  signaux : ${c.reasons.join(' · ')}`)
  if (stress) {
    lines.push(
      `  stress ${pct(stress.defaultRate, 0)} défaut → NAV ${stress.navBefore.toFixed(4)} → ${stress.navAfter.toFixed(4)}  (${pct(stress.navDrawdown)} drawdown)  perte déposants ${stress.vaultLossTotal.toFixed(2)}  cover utilisé ${stress.coveredTotal.toFixed(2)}`,
    )
  }
  const min = tenthBpsToRatio(args.broker.coverRateMinimum)
  const liq = tenthBpsToRatio(args.broker.coverRateLiquidation)
  lines.push(`  proto cover cap = DebtTotal × ${pct(min, 0)} × ${pct(liq, 0)}  (pas CoverAvailable entier)`)
  return lines.join('\n')
}

export function formatBoard(cases) {
  return cases.map(({ title, ...input }) => formatReport(input, title)).join('\n\n')
}
