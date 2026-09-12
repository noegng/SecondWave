#!/usr/bin/env node
/**
 * SecondWave — démonstration en terminal.
 *
 *   npm run world              génère le monde sur le Devnet (une fois)
 *   npm run cli vaults         les quatre vaults, notés par l'analyste
 *   npm run cli book <acheteur>   le carnet tel que cet acheteur le voit
 *   npm run cli sell <vault> <parts> <prixXRP>
 *   npm run cli buy  <offre> <acheteur>
 *   npm run cli demo           le chemin complet, de l'offre au règlement
 *
 * Les acteurs se nomment `<vault>.<rôle><n>` : `sain.d0` est le premier
 * déposant du vault sain, `concentre.b0` son emprunteur unique.
 */
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { connect, Wallet, readVaultGraph, holderMap, shareBalance, rippleNow, txUrl } from '@secondwave/core'
import { SettlementEngine } from '@secondwave/settlement'
import { OrderBook, priceHistory } from '@secondwave/orderbook'
import { scoreBroker, classifyDiscount, navPerShare } from '@secondwave/analyst'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const XRP = d => (Number(d) / 1e6).toFixed(2)

if (!existsSync(join(ROOT, 'world.json')))
  fatal('world.json absent — lance d\'abord `npm run world`.')

const world = JSON.parse(readFileSync(join(ROOT, 'world.json'), 'utf8'))
const seeds = existsSync(join(ROOT, 'state.json'))
  ? JSON.parse(readFileSync(join(ROOT, 'state.json'), 'utf8')) : null

/** L'annuaire : nom lisible → wallet. Vide si state.json manque (lecture seule). */
const acteurs = new Map()
if (seeds) {
  acteurs.set('issuer', Wallet.fromSeed(seeds.issuer))
  acteurs.set('non-membre', Wallet.fromSeed(seeds.nonMember))
  for (const [key, s] of Object.entries(seeds.vaults)) {
    acteurs.set(`${key}.owner`, Wallet.fromSeed(s.owner))
    s.depositors.forEach((sd, i) => acteurs.set(`${key}.d${i}`, Wallet.fromSeed(sd)))
    s.borrowers.forEach((sd, i) => acteurs.set(`${key}.b${i}`, Wallet.fromSeed(sd)))
  }
}
const wallet = name => acteurs.get(name) ?? fatal(`acteur inconnu : ${name}\nconnus : ${[...acteurs.keys()].join(', ')}`)
const vaultOf = key => world.vaults.find(v => v.key === key || v.vaultId === key)
  ?? fatal(`vault inconnu : ${key}\nconnus : ${world.vaults.map(v => v.key).join(', ')}`)

function fatal(msg) { console.error(`\n⛔ ${msg}\n`); process.exit(1) }

const book = new OrderBook(join(ROOT, 'orderbook.json'))
const c = await connect(world.network)
const engine = new SettlementEngine(c)

/** Notation → pastille. Au-dessous de BBB, on n'achète pas sans lire les raisons. */
const COULEUR = r => (['AAA', 'AA', 'A'].includes(r) ? '🟢'
                    : ['BBB', 'BB'].includes(r) ? '🟡'
                    : ['B', 'CCC'].includes(r) ? '🟠' : r === '—' ? '⚪' : '🔴')
const PASTILLE = { liquidity: '🟢 décote de liquidité', distress: '🔴 décote de DÉTRESSE', fair: '⚪ prix ≈ NAV' }

const [cmd, ...args] = process.argv.slice(2)
try {
  switch (cmd) {
    case 'vaults': await cmdVaults(); break
    case 'book': await cmdBook(args[0]); break
    case 'sell': await cmdSell(args[0], args[1], args[2]); break
    case 'buy': await cmdBuy(args[0], args[1]); break
    case 'history': await cmdHistory(args[0]); break
    case 'demo': await cmdDemo(); break
    default:
      console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8')
        .split('\n').slice(2, 15).map(l => l.replace(/^ \* ?/, '')).join('\n'))
  }
} finally { await c.disconnect() }

// ─────────────────────────────────────────────────────────────
// La couture core → analyste.
//
// core.readVaultGraph rend l'objet ledger brut + un bloc `.metrics` ; l'analyste
// de Noé consomme un modèle normalisé en camelCase. Cette fonction est la même
// que `toAnalystInput` dans packages/analyst/src/run.mjs — à fusionner dans core
// quand les deux moitiés se stabiliseront.
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
      didVerified: true,
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

const PIRE = ['AAA', 'AA', 'A', 'BBB', 'BB', 'B', 'CCC', 'CC', 'C', 'D']

/**
 * La note d'un vault. Un vault peut porter plusieurs brokers : on retient
 * le PIRE — un déposant est exposé à tous, pas au meilleur.
 * `discount` est la décote de l'offre examinée (0 = on note le vault seul).
 */
async function noteDe(v, discount = 0) {
  const graph = await readVaultGraph(c, v.vaultId)
  const holders = await holderMap(c, graph.vault)
  const { vault, brokers } = toAnalystInput(graph)
  const now = rippleNow()

  const notes = brokers.map(({ broker, loans }) => ({
    score: scoreBroker({ broker, vault, loans, nowRipple: now }),
    classification: classifyDiscount({ vault, broker, loans, offer: { discount }, nowRipple: now }),
  }))
  notes.sort((a, b) => PIRE.indexOf(b.score.rating) - PIRE.indexOf(a.score.rating))

  const pire = notes[0]
  const note = pire
    ? { ...pire.score, ...pire.classification, nav: navPerShare(vault), brokers: notes.length }
    : { rating: '—', riskScore: null, kind: 'fair', reasons: [],
        headline: 'aucun broker — le capital dort', nav: navPerShare(vault), brokers: 0 }
  return { graph, holders, note }
}

async function cmdVaults() {
  for (const v of world.vaults) {
    const { graph, holders, note } = await noteDe(v)
    console.log(`\n${COULEUR(note.rating)}  ${v.key}  —  ${note.rating}`
      + (note.riskScore != null ? ` (${note.riskScore}/100)` : ''))
    console.log(`    ${v.label}`)
    console.log(`    ${v.vaultId}`)
    console.log(`    phase ${graph.phase} · actifs ${XRP(graph.vault.AssetsTotal)} XRP`
      + ` · disponibles ${XRP(graph.vault.AssetsAvailable)} XRP`
      + ` · NAV ${note.nav.toFixed(4)} drop/part`)
    console.log(`    ${holders.count} détenteurs · concentration ${(holders.concentration * 100).toFixed(0)}%`
      + ` · ${graph.brokers.length} broker(s) · ${graph.brokers.reduce((s, b) => s + b.loans.length, 0)} prêt(s)`)
    if (note.reasons.length) for (const r of note.reasons) console.log(`    🔴 ${r}`)
    else console.log(`    ${note.brokers ? 'aucun signal de risque' : note.headline}`)
  }
  console.log()
}

async function cmdBook(acheteur) {
  if (!acheteur) fatal('usage : cli book <acheteur>')
  const w = wallet(acheteur)
  const offres = await book.viewFor(c, w.classicAddress)
  if (!offres.length) return console.log('\nCarnet vide.\n')

  console.log(`\nCarnet vu par ${acheteur} (${w.classicAddress})\n`)
  const notes = new Map()
  for (const o of offres) {
    const v = world.vaults.find(x => x.vaultId === o.vaultId)
    if (!v) continue
    // La décote de CETTE offre décide si l'analyste parle de liquidité ou de détresse.
    const brut = notes.get(o.vaultId) ?? (notes.set(o.vaultId, await noteDe(v)), notes.get(o.vaultId))
    const nav = brut.note.nav
    const decote = nav > 0 ? Math.max(0, 1 - o.pricePerShare / nav) : 0
    const n = (await noteDe(v, decote)).note
    console.log(`  ${o.id}  ${v.key.padEnd(14)} ${o.shares} parts pour ${XRP(o.price)} XRP`
      + `  —  décote ${(decote * 100).toFixed(1)} %   ${COULEUR(n.rating)} ${n.rating}`)
    console.log(`       ${o.eligible ? '✅' : '⛔'} ${o.reason}`)
    console.log(`       ${PASTILLE[n.kind]}`)
    for (const r of n.reasons) console.log(`       🔴 ${r}`)
  }
  console.log()
}

async function cmdSell(vaultKey, parts, prixXrp) {
  if (!vaultKey || !parts || !prixXrp) fatal('usage : cli sell <vault> <parts> <prixXRP>')
  const v = vaultOf(vaultKey)
  // Le vendeur par défaut est le plus gros détenteur : celui qui a le plus à perdre
  // à rester enfermé jusqu'à la Redemption.
  const seller = v.holders[0]?.account ?? fatal('ce vault n\'a aucun détenteur')
  const o = book.post({ vaultId: v.vaultId, seller, shares: parts, price: String(Math.round(prixXrp * 1e6)) })
  console.log(`\nOffre ${o.id} : ${o.shares} parts de ${v.key} pour ${XRP(o.price)} XRP`)
  console.log(`  vendeur ${seller}\n`)
}

async function cmdBuy(orderId, acheteur) {
  if (!orderId || !acheteur) fatal('usage : cli buy <offre> <acheteur>')
  const o = book.get(orderId) ?? fatal(`offre inconnue : ${orderId}`)
  const v = world.vaults.find(x => x.vaultId === o.vaultId)
  const buyerWallet = wallet(acheteur)
  const sellerWallet = [...acteurs.values()].find(w => w.classicAddress === o.seller)
    ?? fatal('seed du vendeur absente de state.json')

  console.log(`\n─── ANALYSE ───`)
  const brut = await noteDe(v)
  const nav = brut.note.nav
  const pps = Number(o.price) / Number(o.shares)
  const decote = nav > 0 ? Math.max(0, 1 - pps / nav) : 0
  const { note } = await noteDe(v, decote)
  console.log(`  ${COULEUR(note.rating)} ${v.key} : ${note.rating}`
    + (note.riskScore != null ? ` (${note.riskScore}/100)` : ''))
  console.log(`  NAV ${nav.toFixed(4)} drop/part · payé ${pps.toFixed(4)} · décote ${(decote * 100).toFixed(1)} %`)
  console.log(`  ${PASTILLE[note.kind]} — ${note.headline}`)
  for (const r of note.reasons) console.log(`  🔴 ${r}`)

  console.log(`\n─── RÈGLEMENT ───`)
  const r = await engine.executeSwap({
    vaultId: o.vaultId, sellerWallet, buyerWallet,
    shares: o.shares, price: o.price,
  })

  if (r.preflight) for (const ch of r.preflight.checks)
    console.log(`  ${ch.ok === true ? '✅' : ch.ok === false ? '⛔' : '❔'} ${ch.name} — ${ch.detail}`)

  if (r.stage === 'preflight') { console.log(`\n⛔ bloqué avant soumission — aucun drop dépensé.\n`); return }
  if (!r.ok) { console.log(`\n⛔ ${r.stage} : ${r.warning ?? r.message ?? r.engineResult}\n`); return }

  console.log(`\n  Batch ${r.batchResult} — ${r.url}`)
  console.log(`  jambes reconstruites (le BatchExecutions manquant) :`)
  for (const l of r.evidence.legs) console.log(`    ${l.result}  ${l.type.padEnd(18)} ${l.hash.slice(0, 16)}…`)
  console.log(`\n  réconciliation : ${r.moved.shares} parts cédées, ${r.moved.received} reçues,`
    + ` ${XRP(r.moved.paid)} XRP payés  ✅`)
  book.fill(o.id, r.hash)
  console.log(`  offre ${o.id} marquée exécutée.\n`)
}

async function cmdHistory(vaultKey) {
  const v = vaultOf(vaultKey ?? world.vaults[0].key)
  const trades = await priceHistory(c, v.vaultId)
  if (!trades.length) return console.log(`\nAucun échange sur ${v.key}.\n`)
  console.log(`\nHistorique des prix — ${v.key}\n`)
  for (const t of trades)
    console.log(`  ${t.closeTime}  ${t.shares} parts  ${t.price ? XRP(t.price) + ' XRP' : 'prix introuvable'}`
      + `  ${t.pricePerShare ? `(${t.pricePerShare.toFixed(4)} drops/part)` : ''}\n    ${t.url}`)
  console.log()
}

async function cmdDemo() {
  console.log('\n╔══════════════════════════════════════════════════════════════╗')
  console.log('║  SecondWave — sortir d\'une position verrouillée              ║')
  console.log('╚══════════════════════════════════════════════════════════════╝')
  await cmdVaults()

  // Deux offres au même prix sur deux vaults opposés : c'est le moment du pitch.
  const sain = vaultOf('sain'), risque = vaultOf('sans-garantie')
  const partsSain = BigInt(sain.holders[0].shares) / 2n
  const partsRisque = BigInt(risque.holders[0].shares) / 2n
  book.post({ vaultId: sain.vaultId, seller: sain.holders[0].account, shares: partsSain, price: String(partsSain * 90n / 100n) })
  book.post({ vaultId: risque.vaultId, seller: risque.holders[0].account, shares: partsRisque, price: String(partsRisque * 90n / 100n) })
  console.log('Deux offres à la MÊME décote. L\'analyste sépare la liquidité de la détresse :\n')
  await cmdBook('sain.d1')
}
