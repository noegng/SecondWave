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
import { connect, Wallet, readVaultGraph, holderMap, shareBalance, txUrl } from '@secondwave/core'
import { SettlementEngine } from '@secondwave/settlement'
import { OrderBook, priceHistory } from '@secondwave/orderbook'
import { analyse } from '@secondwave/analyst'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const XRP = d => (Number(d) / 1e6).toFixed(2)
/** Un montant IOU est déjà dans son unité : le diviser par 1e6 afficherait 0.00. */
const montant = (graph, raw) => graph.metrics.isIou
  ? `${Number(raw)} ${graph.vault.Asset.currency}`
  : `${XRP(raw)} XRP`
/** nav est ×1e6 avec 1e6 = pair, pas des drops. */
const parPart = nav => (Number(nav) / 1e6).toFixed(4)

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

const COULEUR = { sain: '🟢', prudence: '🟡', risqué: '🟠', 'à fuir': '🔴' }
const PUCE = { info: '·', alerte: '⚠️ ', rouge: '🔴' }

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
async function noteDe(v, order) {
  const graph = await readVaultGraph(c, v.vaultId)
  const holders = await holderMap(c, graph.vault)
  return { graph, holders, note: analyse({ graph, holders, order }) }
}

async function cmdVaults() {
  for (const v of world.vaults) {
    const { graph, holders, note } = await noteDe(v)
    console.log(`\n${COULEUR[note.verdict]}  ${v.key}  —  ${note.verdict} (${note.score}/100)`)
    console.log(`    ${v.label}`)
    console.log(`    ${v.vaultId}`)
    console.log(`    phase ${graph.phase} · actifs ${montant(graph, graph.vault.AssetsTotal)}`
      + ` · disponibles ${montant(graph, graph.vault.AssetsAvailable)}`
      + ` · NAV ${parPart(note.nav)}/part (pair 1.0000)`)
    console.log(`    ${holders.count} détenteurs · concentration ${(holders.concentration * 100).toFixed(0)}%`
      + ` · ${graph.brokers.length} broker(s) · ${graph.brokers.reduce((s, b) => s + b.loans.length, 0)} prêt(s)`)
    for (const s of note.signaux) console.log(`    ${PUCE[s.niveau]} ${s.titre} — ${s.detail}`)
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
    if (!notes.has(o.vaultId)) notes.set(o.vaultId, (await noteDe(v)).note)
    const n = notes.get(o.vaultId)
    console.log(`  ${o.id}  ${v.key.padEnd(14)} ${o.shares} parts pour ${XRP(o.price)} XRP`
      + `   ${COULEUR[n.verdict]} ${n.verdict} ${n.score}/100`)
    console.log(`       ${o.eligible ? '✅' : '⛔'} ${o.reason}`)
    for (const s of n.signaux.filter(x => x.niveau === 'rouge'))
      console.log(`       🔴 ${s.titre}`)
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
  // L'ordre est indispensable : sans lui `fairPrice` est null et on comparerait
  // un prix par part au prix total demandé.
  const { note } = await noteDe(v, { shares: o.shares })
  console.log(`  ${COULEUR[note.verdict]} ${v.key} : ${note.verdict} (${note.score}/100)`)
  console.log(`  ${o.shares} parts · prix demandé ${XRP(o.price)} XRP`
    + ` · prix « juste » selon l'analyste ${note.fairPrice == null ? 'n/a (parts non transférables)' : `${XRP(note.fairPrice)} XRP`}`)
  for (const s of note.signaux) console.log(`  ${PUCE[s.niveau]} ${s.titre} — ${s.detail}`)

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
  const sain = vaultOf('sain'), risque = vaultOf('predateur')
  const partsSain = BigInt(sain.holders[0].shares) / 2n
  const partsRisque = BigInt(risque.holders[0].shares) / 2n
  book.post({ vaultId: sain.vaultId, seller: sain.holders[0].account, shares: partsSain, price: String(partsSain * 90n / 100n) })
  book.post({ vaultId: risque.vaultId, seller: risque.holders[0].account, shares: partsRisque, price: String(partsRisque * 90n / 100n) })
  console.log('Deux offres au même prix par part. L\'analyste les sépare :\n')
  await cmdBook('sain.d1')
}
