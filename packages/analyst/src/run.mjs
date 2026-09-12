/**
 * packages/analyst/src/run.mjs — le runner HORS LIGNE de l'analyste.
 *
 *   npm run analyse -- <cléDuVault>     (ou: node packages/analyst/src/run.mjs <clé>)
 *   npm run analyse                     (liste les vaults disponibles)
 *
 * Charge snapshot.json (aucun réseau, aucun faucet, aucune attente) et imprime :
 *   1. les FAITS dérivés par core (readVaultGraph + holderMap) ;
 *   2. la note de l'analyste réel de Noé (scoreBroker / ratingFromScore / analyzeOffer).
 *
 * ⚠️ Pont d'intégration : Noé consomme un modèle NORMALISÉ (champs camelCase :
 *    debtTotal, coverAvailable, sharesOutstanding…). core.readVaultGraph rend
 *    l'objet ledger brut + un bloc `.metrics`. `toAnalystInput()` ci-dessous fait
 *    la conversion — c'est la couture entre les deux couches.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import * as analyst from './index.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
let snapshot
try {
  snapshot = JSON.parse(readFileSync(join(ROOT, 'snapshot.json'), 'utf8'))
} catch {
  console.error('snapshot.json introuvable — lancer `npm run world` d\'abord (nécessite le Devnet).')
  process.exit(1)
}

const key = process.argv[2]
const keys = Object.keys(snapshot.vaults)
if (!key) {
  console.log('Vaults disponibles :')
  for (const k of keys) console.log(`  ${k.padEnd(12)} — ${snapshot.vaults[k].meta.label}`)
  console.log('\nUsage : npm run analyse -- <clé>')
  process.exit(0)
}
if (!snapshot.vaults[key]) {
  console.error(`vault « ${key} » inconnu. Disponibles : ${keys.join(', ')}`)
  process.exit(1)
}

/** Convertit un graph core (brut + .metrics) vers le modèle normalisé de l'analyste. */
function toAnalystInput(graph) {
  const vm = graph.metrics
  const vault = {
    vaultId: graph.vaultId,
    assetsTotal: vm.assetsTotal,
    assetsAvailable: vm.assetsAvailable,
    lossUnrealized: vm.lossUnrealized,
    sharesOutstanding: vm.outstandingShares,
    vaultKind: Number(graph.vault.VaultKind ?? 0),
    subscriptionDate: Number(graph.vault.SubscriptionDate ?? 0),
    redemptionDate: Number(graph.vault.RedemptionDate ?? 0),
  }
  const brokers = graph.brokers.map(b => ({
    broker: {
      loanBrokerId: b.index,
      vaultId: graph.vaultId,
      debtTotal: b.metrics.debtTotal,
      coverAvailable: b.metrics.coverAvailable,
      coverRateMinimum: b.metrics.coverRateMinimum,
      coverRateLiquidation: b.metrics.coverRateLiquidation,
      managementFeeRate: Number(b.ManagementFeeRate ?? 0),
      didVerified: true,   // owner crédentialisé dans le monde généré
    },
    loans: b.loans.map(l => ({
      loanId: l.index,
      principalOutstanding: l.metrics.principalOutstanding,
      totalValueOutstanding: l.metrics.totalValueOutstanding ?? '0',
      managementFeeOutstanding: l.ManagementFeeOutstanding ?? '0',
      nextPaymentDueDate: Number(l.NextPaymentDueDate ?? 0),
      gracePeriod: Number(l.GracePeriod ?? 0),
      flags: Number(l.Flags ?? 0),
    })),
  }))
  return { vault, brokers }
}

const { meta, graph, holders } = snapshot.vaults[key]
const m = graph.metrics
const nowRipple = Number(snapshot.capturedAtRipple)

console.log(`\n════ ${key} ════ ${meta.label}`)
console.log(`snapshot figé à Ripple-time ${snapshot.capturedAtRipple}\n`)

// ── 1. LES FAITS (ce que core dérive) ────────────────────────
console.log('FAITS DÉRIVÉS (core.readVaultGraph + holderMap) :')
console.log(`  phase           ${m.phase ?? '(open-ended)'}${m.secondsRemaining != null ? ` (reste ${m.secondsRemaining}s)` : ''}`)
console.log(`  actif           ${meta.asset}${m.isIou ? ` émis par ${m.assetIssuer}` : ''}${meta.clawbackArmed ? '  🔴 clawback armé' : ''}`)
console.log(`  NAV/part        ${m.navPerShare}  (prudente ${m.navPrudentPerShare})`)
console.log(`  utilisation     ${m.utilisation ?? 0}   perte latente ${m.lossRatio ?? 0}`)
console.log(`  parts non transf. ${m.shareNonTransferable}`)
console.log(`  détenteurs      ${holders.count}  concentration ${holders.concentration}  HHI ${holders.hhi}`)
console.log(`  résumé          brokers=${m.brokerCount} prêts=${m.loanCount}`
  + ` sansCover=${m.hasUncoveredBroker} autoPrêt=${m.hasSelfLoan} défautNonDéclaré=${m.hasUndeclaredDefault}`)
for (const b of graph.brokers) {
  const bm = b.metrics
  console.log(`  broker ${(bm.owner ?? '?').slice(0, 10)}…  cover ${bm.coverAvailable} (retirable ${bm.coverWithdrawable}${bm.coverWithdrawableIsEstimate ? '~' : ''})`
    + ` dette ${bm.debtTotal}  taux ${bm.coverRateMinimumPct}%/${bm.coverRateLiquidationPct}%${bm.noCover ? '  🔴 0/0' : ''}`)
  for (const l of b.loans) {
    const lm = l.metrics
    console.log(`     prêt ${lm.borrower?.slice(0, 10)}…  ${lm.status}`
      + `${lm.selfLoan ? ' 🔴 AUTO-PRÊT' : ''}${lm.defaillable ? ` (défaillable, +${lm.secondsLate}s)` : ''}`
      + `  poids ${lm.weight ?? 0}`)
  }
}

// ── 2. LA NOTE (analyste réel de Noé, via le pont de normalisation) ──
console.log('\nNOTE ANALYSTE (Noé) :')
const input = toAnalystInput(graph)
if (typeof analyst.scoreBroker !== 'function') {
  console.log('  (aucune fonction scoreBroker exportée — API analyste absente)')
} else if (!input.brokers.length) {
  console.log('  (aucun broker sur ce vault — rien à noter)')
} else {
  for (const { broker, loans } of input.brokers) {
    try {
      const sc = analyst.scoreBroker({ broker, vault: input.vault, loans, nowRipple })
      const score = typeof sc === 'number' ? sc : (sc?.riskScore ?? sc?.score)
      const rating = (typeof sc === 'object' && sc?.rating) || (analyst.ratingFromScore ? analyst.ratingFromScore(score) : '?')
      console.log(`  broker ${broker.loanBrokerId.slice(0, 10)}…  score ${typeof score === 'number' ? score.toFixed(1) : score} · note ${rating}`
        + `  (dette ${broker.debtTotal}, cover ${broker.coverAvailable}, ${loans.length} prêt(s))`)
    } catch (e) {
      console.log(`  broker ${broker.loanBrokerId.slice(0, 10)}… — scoreBroker a échoué : ${e.message}`)
    }
  }
}
console.log()
