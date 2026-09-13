#!/usr/bin/env node
/**
 * SecondWave — démonstration en terminal.
 *
 *   npm run world              génère le monde sur le Devnet (une fois)
 *   npm run cli vaults         les vaults, notés par l'analyste
 *   npm run cli book <acheteur>   le carnet tel que cet acheteur le voit
 *   npm run cli sell <vault> <parts> <prixXRP>
 *   npm run cli buy  <offre> <acheteur>
 *   npm run cli demo           le chemin complet, de l'offre au règlement
 *
 *   — le rail DURABLE, en quatre gestes (l'offre n'expire pas) —
 *   npm run cli offer <vault> <parts> <prixXRP>   le vendeur publie
 *   npm run cli take <offre> <acheteur>           l'acheteur s'engage
 *   npm run cli pending <vendeur>                 ce qui attend sa réponse
 *   npm run cli confirm <offre>                   le vendeur confirme, ça règle
 *   npm run cli annuler <offre>                   le vendeur brûle le ticket
 *   npm run cli retirer <offre>                   l'acheteur retire son engagement
 *
 * Les acteurs se nomment `<vault>.<rôle><n>` : `sain.d0` est le premier
 * déposant du vault sain, `predateur.b0` son emprunteur unique.
 */
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { connect, Wallet, readVaultGraph, holderMap, shareBalance } from '@secondwave/core'
import {
  SettlementEngine, ensureTickets, TICKETS_SELLER, ticketsBuyer,
  buildOffer, signAsBuyer, signAsSeller, submitOffer,
  cancelOffer, withdrawCommitment, offerAlive,
} from '@secondwave/settlement'
import { OrderBook, priceHistory, STATUS, EN_COURS } from '@secondwave/orderbook'
import { analyse, classifyDiscount, toAnalystInput } from '@secondwave/analyst'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const XRP = d => (Number(d) / 1e6).toFixed(2)
/** Ripple-time courant — pour mesurer depuis quand un acheteur attend. */
const rippleNowLocal = () => Math.floor(Date.now() / 1000) - 946684800
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
/** Les adresses dont on détient la seed : les seules qui peuvent signer un Batch. */
const signables = new Set([...acteurs.values()].map(w => w.classicAddress))
const invites = new Set(world.guests ?? (world.guest ? [world.guest] : []))
const vaultOf = key => world.vaults.find(v => v.key === key || v.vaultId === key)
  ?? fatal(`vault inconnu : ${key}\nconnus : ${world.vaults.map(v => v.key).join(', ')}`)

function fatal(msg) { console.error(`\n⛔ ${msg}\n`); process.exit(1) }

/**
 * Le plus gros détenteur DONT on a la seed. Un wallet invité (extension) peut
 * détenir des parts, mais pas les vendre ici : le Batch exige sa clé privée.
 */
function vendeurDe(v) {
  if (!v.holders?.length) fatal(`${v.key} n'a aucun détenteur`)
  const candidats = v.holders.filter(h => signables.has(h.account))
  if (!candidats.length)
    fatal(`aucun détenteur de ${v.key} n'est dans state.json — personne ne peut signer le Batch.`)
  const seller = candidats.reduce((a, b) => (BigInt(b.shares) > BigInt(a.shares) ? b : a)).account
  if (v.holders[0].account !== seller)
    console.log(`\n  ℹ️  ${v.holders[0].account} détient plus, mais c'est un wallet invité`
      + ` — pas de seed ici. Vendeur retenu : le plus gros signable.`)
  return seller
}

const book = new OrderBook(join(ROOT, 'orderbook.json'))
const c = await connect(world.network)
const engine = new SettlementEngine(c)

const VERDICT = { sain: '🟢', prudence: '🟡', risqué: '🟠', 'à fuir': '🔴' }
const PUCE = { info: '·', alerte: '⚠️ ', rouge: '🔴' }
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
    case 'offer': await cmdOffer(args[0], args[1], args[2]); break
    case 'take': await cmdTake(args[0], args[1]); break
    case 'pending': await cmdPending(args[0]); break
    case 'confirm': await cmdConfirm(args[0]); break
    case 'annuler': case 'cancel': await cmdAnnuler(args[0]); break
    case 'retirer': await cmdRetirer(args[0]); break
    default:
      console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8')
        .split('\n').slice(2, 15).map(l => l.replace(/^ \* ?/, '')).join('\n'))
  }
} finally { await c.disconnect() }

// ─────────────────────────────────────────────────────────────
/** Lecture live + `analyse()`. `order` n'est passé que pour un prix total. */
async function lire(v, order) {
  const graph = await readVaultGraph(c, v.vaultId)
  const holders = await holderMap(c, graph.vault)
  return { graph, holders, note: analyse({ graph, holders, order }) }
}

/**
 * Décote d'une offre. `note.nav` est ×1e6 (1e6 = pair) ; `price`/`shares`
 * sont en drops et parts — le ratio est le même qu'avec navPerShare (~1 au pair).
 */
function decoteDe(note, o) {
  const nav = Number(note.nav) / 1e6
  const pps = Number(o.price) / Number(o.shares)
  return { nav, pps, decote: nav > 0 ? Math.max(0, 1 - pps / nav) : 0 }
}

/** Verdict liquidité vs détresse d'Hugo, sur le pire broker du vault. */
function classement(graph, decote) {
  const { vault, brokers } = toAnalystInput(graph)
  const now = Number(graph.at ?? 0)
  if (!brokers.length) {
    return { kind: 'fair', reasons: [], headline: 'aucun broker — le capital dort' }
  }
  const notes = brokers.map(({ broker, loans }) =>
    classifyDiscount({ vault, broker, loans, offer: { discount: decote }, nowRipple: now }))
  return notes.find(n => n.kind === 'distress') ?? notes.find(n => n.kind === 'liquidity') ?? notes[0]
}

async function cmdVaults() {
  for (const v of world.vaults) {
    const { graph, holders, note } = await lire(v)
    console.log(`\n${VERDICT[note.verdict]}  ${v.key}  —  ${note.verdict} (${note.score}/100)`)
    console.log(`    ${v.label}`)
    console.log(`    ${v.vaultId}`)
    console.log(`    phase ${graph.phase} · actifs ${montant(graph, graph.vault.AssetsTotal)}`
      + ` · disponibles ${montant(graph, graph.vault.AssetsAvailable)}`
      + ` · NAV ${parPart(note.nav)}/part (pair 1.0000)`)
    console.log(`    ${holders.count} détenteurs · concentration ${(holders.concentration * 100).toFixed(0)}%`
      + ` · ${graph.brokers.length} broker(s) · ${graph.brokers.reduce((s, b) => s + b.loans.length, 0)} prêt(s)`)
    // Les wallets réels présents au capital : c'est ce qui prouve que le monde est ouvert.
    for (const h of (holders.holders ?? []).filter(h => invites.has(h.account)))
      console.log(`    👤 wallet invité ${h.account} — ${h.shares} parts`)
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
  const cache = new Map()
  for (const o of offres) {
    const v = world.vaults.find(x => x.vaultId === o.vaultId)
    if (!v) continue
    if (!cache.has(o.vaultId)) cache.set(o.vaultId, await lire(v))
    const { graph, note } = cache.get(o.vaultId)
    const { decote } = decoteDe(note, o)
    const n = classement(graph, decote)
    console.log(`  ${o.id}  ${v.key.padEnd(14)} ${o.shares} parts pour ${XRP(o.price)} XRP`
      + `  —  décote ${(decote * 100).toFixed(1)} %   ${VERDICT[note.verdict]} ${note.verdict} ${note.score}/100`)
    console.log(`       ${o.eligible ? '✅' : '⛔'} ${o.reason}`)
    console.log(`       ${PASTILLE[n.kind]}`)
    for (const s of note.signaux.filter(x => x.niveau === 'rouge'))
      console.log(`       🔴 ${s.titre}`)
    for (const r of n.reasons) console.log(`       🔴 ${r}`)
  }
  console.log()
}

async function cmdSell(vaultKey, parts, prixXrp) {
  if (!vaultKey || !parts || !prixXrp) fatal('usage : cli sell <vault> <parts> <prixXRP>')
  const v = vaultOf(vaultKey)
  // Le vendeur par défaut est le plus gros détenteur : celui qui a le plus à perdre
  // à rester enfermé jusqu'à la Redemption. Mais le Batch exige sa clé privée
  // (settlement/batch.mjs) : un wallet invité détient des parts sans pouvoir vendre.
  const seller = vendeurDe(v)
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
  const { graph, note } = await lire(v, { shares: o.shares })
  const { nav, pps, decote } = decoteDe(note, o)
  const n = classement(graph, decote)
  console.log(`  ${VERDICT[note.verdict]} ${v.key} : ${note.verdict} (${note.score}/100)`)
  console.log(`  ${o.shares} parts · demandé ${XRP(o.price)} XRP`
    + ` · juste ${note.fairPrice == null ? 'n/a (parts non transférables)' : `${XRP(note.fairPrice)} XRP`}`)
  console.log(`  NAV ${nav.toFixed(4)}/part · payé ${pps.toFixed(4)} · décote ${(decote * 100).toFixed(1)} %`)
  console.log(`  ${PASTILLE[n.kind]} — ${n.headline}`)
  for (const s of note.signaux) console.log(`  ${PUCE[s.niveau]} ${s.titre} — ${s.detail}`)
  for (const r of n.reasons) console.log(`  🔴 ${r}`)

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

// ═════════════════════════════════════════════════════════════
// LE RAIL DURABLE — l'offre survit à l'attente
//
// Le rail classique (sell/buy) construit et signe tout d'un coup : l'enveloppe
// meurt en ~72 s et dès que l'un des deux comptes transige ailleurs. Ici les
// jambes sont portées par des Tickets et l'enveloppe n'a pas d'expiration : le
// vendeur peut confirmer dans une heure, et garde la main jusqu'au bout.
// ═════════════════════════════════════════════════════════════

/** Le wallet d'une adresse, ou null si sa seed n'est pas dans state.json. */
const walletDe = addr => [...acteurs.values()].find(w => w.classicAddress === addr) ?? null

/** Les tickets déjà promis à des offres en cours — ils ne sont pas libres. */
function ticketsEngages(account) {
  return book.orders
    .filter(o => EN_COURS.includes(o.status))
    .flatMap(o => (o.seller === account ? (o.sellerTickets ?? []) : [])
      .concat(o.buyer === account ? (o.buyerTickets ?? []) : []))
}

async function cmdOffer(vaultKey, parts, prixXrp) {
  if (!vaultKey || !parts || !prixXrp) fatal('usage : cli offer <vault> <parts> <prixXRP>')
  const v = vaultOf(vaultKey)
  const seller = vendeurDe(v)
  const sellerWallet = walletDe(seller) ?? fatal('seed du vendeur absente de state.json')

  // ⭐ Survente : ce que le vendeur a déjà promis compte, offres engagées
  //    comprises. Mieux vaut refuser ici qu'échouer au règlement.
  const bal = await shareBalance(c, seller, v.shareMptId)
  const garde = book.canOffer({ seller, vaultId: v.vaultId, shares: parts, balance: bal.amount })
  if (!garde.ok) fatal(garde.reason)
  console.log(`\n  solde ${garde.balance} parts · déjà promises ${garde.engaged} · libres ${garde.free}`)

  console.log(`\n─── TICKETS ───`)
  const t = await ensureTickets(c, sellerWallet, TICKETS_SELLER, { reserved: ticketsEngages(seller) })
  if (t.ok === false) fatal(`TicketCreate : ${t.result} ${t.message ?? ''}`)
  const tickets = t.free.slice(0, TICKETS_SELLER)
  console.log(`  ${t.created ? `${t.created} ticket(s) créé(s)` : 'tickets déjà disponibles'}`
    + ` — retenus : ${tickets.join(', ')}`)

  const o = book.post({
    vaultId: v.vaultId, seller, shares: parts,
    price: String(Math.round(prixXrp * 1e6)),
    ttl: null,                 // pas d'expiration : c'est tout l'intérêt
    sellerTickets: tickets,
  })
  console.log(`\nOffre ${o.id} publiée : ${o.shares} parts de ${v.key} pour ${XRP(o.price)} XRP`)
  console.log(`  vendeur ${seller}`)
  console.log(`  durable — aucune expiration. Rien n'est signé, rien n'est engagé.`)
  console.log(`  l'acheteur : npm run cli take ${o.id} <acheteur>\n`)
}

async function cmdTake(orderId, acheteur) {
  if (!orderId || !acheteur) fatal('usage : cli take <offre> <acheteur>')
  const o = book.get(orderId) ?? fatal(`offre inconnue : ${orderId}`)
  if (o.status !== STATUS.OPEN) fatal(`offre ${o.id} est « ${o.status} » — elle n'est plus à prendre`)
  if (!o.durable) fatal(`offre ${o.id} n'est pas durable — utiliser « cli buy ${o.id} ${acheteur} »`)
  const v = world.vaults.find(x => x.vaultId === o.vaultId) ?? fatal('vault inconnu')
  const buyerWallet = wallet(acheteur)
  const buyer = buyerWallet.classicAddress

  console.log(`\n─── ANALYSE ───`)
  const { graph, note } = await lire(v, { shares: o.shares })
  const { nav, pps, decote } = decoteDe(note, o)
  const n = classement(graph, decote)
  console.log(`  ${VERDICT[note.verdict]} ${v.key} : ${note.verdict} (${note.score}/100)`)
  console.log(`  NAV ${nav.toFixed(4)}/part · payé ${pps.toFixed(4)} · décote ${(decote * 100).toFixed(1)} %`)
  console.log(`  ${PASTILLE[n.kind]} — ${n.headline}`)
  for (const s of note.signaux) console.log(`  ${PUCE[s.niveau]} ${s.titre} — ${s.detail}`)

  // L'autorisation MPT n'est une jambe que si l'acheteur ne détient pas encore l'objet.
  const bal = await shareBalance(c, buyer, v.shareMptId)
  const needsAuthorize = !bal.holds
  const need = ticketsBuyer(needsAuthorize)

  console.log(`\n─── TICKETS ───`)
  const t = await ensureTickets(c, buyerWallet, need, { reserved: ticketsEngages(buyer) })
  if (t.ok === false) fatal(`TicketCreate : ${t.result} ${t.message ?? ''}`)
  const buyerTickets = t.free.slice(0, need)
  console.log(`  ${needsAuthorize ? 'autorisation MPT nécessaire' : 'acheteur déjà autorisé'}`
    + ` — ${need} ticket(s) : ${buyerTickets.join(', ')}`)

  const batch = buildOffer({
    sellerAddress: o.seller, buyerAddress: buyer, mptId: v.shareMptId,
    shares: o.shares, price: o.price,
    sellerTickets: o.sellerTickets, buyerTickets, needsAuthorize,
  })
  signAsBuyer(batch, buyerWallet)

  o.buyerTickets = buyerTickets
  const m = book.match(o.id, { buyer, batch })
  if (!m.ok) fatal(m.reason)
  book.save()

  console.log(`\n─── ENGAGEMENT ───`)
  console.log(`  ✅ ${acheteur} a signé ses BatchSigners.`)
  console.log(`  L'offre attend la confirmation du vendeur — sans limite de temps.`)
  console.log(`  le vendeur : npm run cli confirm ${o.id}\n`)
}

async function cmdPending(vendeur) {
  const addr = vendeur && acteurs.has(vendeur) ? wallet(vendeur).classicAddress : vendeur
  const list = addr ? book.pending(addr) : book.orders.filter(o => o.status === STATUS.MATCHED)
  if (!list.length) return console.log('\nAucune offre en attente de confirmation.\n')
  console.log(`\nEn attente de votre confirmation :\n`)
  for (const o of list) {
    const v = world.vaults.find(x => x.vaultId === o.vaultId)
    console.log(`  ${o.id}  ${(v?.key ?? '?').padEnd(12)} ${o.shares} parts pour ${XRP(o.price)} XRP`)
    console.log(`       acheteur ${o.buyer}`)
    console.log(`       confirmer : npm run cli confirm ${o.id}   ·   annuler : npm run cli annuler ${o.id}`)
  }
  console.log()
}

async function cmdConfirm(orderId) {
  if (!orderId) fatal('usage : cli confirm <offre>')
  const o = book.get(orderId) ?? fatal(`offre inconnue : ${orderId}`)
  if (o.status !== STATUS.MATCHED) fatal(`offre ${o.id} est « ${o.status} » — rien à confirmer`)
  const sellerWallet = walletDe(o.seller) ?? fatal('seed du vendeur absente de state.json')

  // Le vendeur a pu annuler entre-temps depuis ailleurs : le ledger tranche.
  if (!await offerAlive(c, o.batch))
    fatal(`le ticket d'enveloppe a été consommé — cette offre est déjà annulée.`)

  signAsSeller(o.batch, sellerWallet)
  book.confirm(o.id, o.batch)
  console.log(`\n  ✅ vendeur confirmé. L'offre est soumettable.`)

  console.log(`\n─── RÈGLEMENT ───`)
  const r = await submitOffer(c, o.batch)
  if (!r.ok) {
    console.log(`\n⛔ ${r.stage} : ${r.message ?? r.engineResult ?? r.batchResult}\n`)
    return
  }
  console.log(`  Batch ${r.batchResult} — ${r.url}`)
  console.log(`  jambes reconstruites (le BatchExecutions manquant) :`)
  for (const l of r.evidence.legs) console.log(`    ${l.result}  ${l.type.padEnd(18)} ${l.hash.slice(0, 16)}…`)
  book.fill(o.id, r.hash)
  console.log(`\n  offre ${o.id} marquée exécutée.\n`)
}

async function cmdAnnuler(orderId) {
  if (!orderId) fatal('usage : cli annuler <offre>')
  const o = book.get(orderId) ?? fatal(`offre inconnue : ${orderId}`)
  const sellerWallet = walletDe(o.seller) ?? fatal('seed du vendeur absente de state.json')

  const r = await book.cancelDurable(c, sellerWallet, o.id, { cancelOffer })
  if (!r.ok) fatal(r.reason)
  if (!r.onChain) {
    console.log(`\n  offre ${o.id} retirée du carnet (offre non durable, rien à brûler).\n`)
    return
  }
  console.log(`\n  ✅ offre ${o.id} annulée${r.alreadyCancelled ? ' (elle l\'était déjà)' : ''}.`)
  console.log(`  ticket ${r.ticket} consommé — le Batch signé est devenu insoumettable (tefNO_TICKET).`)
  if (r.url) console.log(`  ${r.url}`)
  console.log()
}

async function cmdRetirer(orderId) {
  if (!orderId) fatal('usage : cli retirer <offre>')
  const o = book.get(orderId) ?? fatal(`offre inconnue : ${orderId}`)
  if (!o.buyer) fatal(`offre ${o.id} n'a pas d'acheteur engagé`)
  const buyerWallet = walletDe(o.buyer) ?? fatal('seed de l\'acheteur absente de state.json')

  const attente = rippleNowLocal() - (o.matchedAt ?? 0)
  const r = await book.withdrawCommitment(c, buyerWallet, o.id, { withdrawCommitment })
  if (!r.ok) fatal(r.reason)
  console.log(`\n  ✅ engagement retiré après ${Math.round(attente / 60)} min d'attente.`)
  console.log(`  ticket de l'acheteur consommé — le Batch est insoumettable.`)
  console.log(`  l'offre ${o.id} est de nouveau ouverte : le vendeur n'a rien dépensé.`)
  if (r.url) console.log(`  ${r.url}`)
  console.log()
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
  const vendeurSain = vendeurDe(sain), vendeurRisque = vendeurDe(risque)
  const partsDe = (v, addr) => BigInt(v.holders.find(h => h.account === addr).shares) / 2n
  const partsSain = partsDe(sain, vendeurSain)
  const partsRisque = partsDe(risque, vendeurRisque)
  book.post({ vaultId: sain.vaultId, seller: vendeurSain, shares: partsSain, price: String(partsSain * 90n / 100n) })
  book.post({ vaultId: risque.vaultId, seller: vendeurRisque, shares: partsRisque, price: String(partsRisque * 90n / 100n) })
  console.log('Deux offres à la MÊME décote. L\'analyste sépare la liquidité de la détresse :\n')
  await cmdBook('sain.d1')
}
