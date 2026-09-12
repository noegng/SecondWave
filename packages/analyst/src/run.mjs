/**
 * packages/analyst/src/run.mjs — le runner HORS LIGNE de l'analyste.
 *
 *   npm run analyse -- <cléDuVault>     (ou: node packages/analyst/src/run.mjs <clé>)
 *   npm run analyse                     (liste les vaults disponibles)
 *
 * Charge snapshot.json (aucun réseau, aucun faucet, aucune attente), appelle
 * analyse({ graph, holders, order }) et imprime :
 *   1. les FAITS dérivés par core (ce que Noé reçoit tout mâché) ;
 *   2. le résultat de analyse() (ce que Noé produit).
 *
 * Le bloc « faits » ne juge pas — il expose la matière première. C'est la cible
 * que la fonction analyse() doit apprendre à noter (voir CONTRAT.md).
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { analyse } from './index.mjs'

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

const { meta, graph, holders } = snapshot.vaults[key]
const m = graph.metrics

console.log(`\n════ ${key} ════ ${meta.label}`)
console.log(`snapshot figé à Ripple-time ${snapshot.capturedAtRipple}\n`)

// ── 1. LES FAITS (ce que core dérive pour l'analyste) ─────────
console.log('FAITS DÉRIVÉS (core.readVaultGraph + holderMap) :')
console.log(`  phase           ${m.phase ?? '(open-ended)'}${m.secondsRemaining != null ? ` (reste ${m.secondsRemaining}s)` : ''}`)
console.log(`  actif           ${meta.asset}${m.isIou ? ` émis par ${m.assetIssuer}` : ''}${meta.clawbackArmed ? '  🔴 clawback armé' : ''}`)
console.log(`  NAV/part        ${m.navPerShare}  (prudente ${m.navPrudentPerShare})`)
console.log(`  utilisation     ${m.utilisation ?? 0}   perte latente ${m.lossRatio ?? 0}`)
console.log(`  parts non transf. ${m.shareNonTransferable}`)
console.log(`  détenteurs      ${holders.count}  concentration ${holders.concentration}  HHI ${holders.hhi}`)
console.log(`  rejeu réconcilié ${holders.reconciles}`)
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

// ── 2. LE VERDICT (ce que analyse() produit) ──────────────────
const note = analyse({ graph, holders, order: null })
console.log(`\nVERDICT analyse()${note.placeholder ? ' [placeholder — Noé remplace le corps]' : ''} :`)
console.log(`  score ${note.score}/100 · ${note.verdict} · NAV ${note.nav}`)
for (const s of note.signaux) {
  const icon = s.niveau === 'rouge' ? '🔴' : s.niveau === 'alerte' ? '🟠' : 'ℹ️ '
  console.log(`  ${icon} ${s.titre} — ${s.detail}`)
}
if (!note.signaux.length) console.log('  (aucun signal — le placeholder ne couvre qu\'un sous-ensemble)')
console.log()
