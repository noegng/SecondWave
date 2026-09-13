/**
 * Matrice de vérification PUBLIC × PRIVÉ — tout le câblage MPT, sur la chaîne.
 *
 *   node packages/settlement/scripts/matrice.mjs        (~6 minutes)
 *
 * Construit son propre décor (2 vaults closed-ended neufs, un public, un privé,
 * comptes dédiés — AUCUNE dépendance à world.json/state.json, donc insensible à
 * la désynchronisation seeds/monde relevée dans QA-hugo1 §1), puis traverse
 * chaque norme PAR LES VRAIS PACKAGES (@secondwave/settlement, orderbook) :
 *
 *   XLS-33  flags de l'issuance de parts (56 public / 60 privé), autorisation,
 *           gate sur les transferts, MPT comme MOYEN DE PAIEMENT
 *   XLS-56  Batch tfAllOrNothing : swap nominal + « Batch menteur » attrapé
 *           par la réconciliation
 *   XLS-65  closed-ended : VaultKind 1, dépôt en Subscription, retrait BLOQUÉ
 *           en Investment (la raison d'être du produit)
 *   XLS-80  permissioned domains : preflight, gate au Payment, gate à
 *           l'EscrowCreate, annotations du carnet
 *   XLS-85  escrow de MPT : HTLC 4 étapes, MPToken auto-créé, LockedAmount,
 *           refund intégral
 *
 * Chaque ✅/❌ est adossé à un code mesuré ou à des soldes — jamais au seul
 * code de retour d'un Batch.
 */
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import {
  connect, Wallet, fundAccount, submit, readVault, shareBalance, xrpBalance,
  sleep, rippleNow, phaseOf,
} from '@secondwave/core'
import { issueCredential, createDomain, createVault, deposit } from '@secondwave/vault'
import { SettlementEngine, htlc } from '@secondwave/settlement'
import { OrderBook, priceHistory } from '@secondwave/orderbook'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const XRP = d => (Number(d) / 1e6).toFixed(6)
const t0 = Date.now()
const log = m => console.log(`[${((Date.now() - t0) / 1000).toFixed(0).padStart(3)}s] ${m}`)

const table = []
let echecs = 0
function check(id, norme, quoi, cond, mesure) {
  if (!cond) echecs++
  table.push({ id, norme, quoi, ok: cond, mesure })
  console.log(`  ${cond ? '✅' : '❌'} ${id} [${norme}] ${quoi}\n        ${mesure}`)
}

const c = await connect()
const e = new SettlementEngine(c)

// ═══════════════════════════════════════════════════════════════
// DÉCOR — comptes dédiés, deux vaults closed-ended neufs
// ═══════════════════════════════════════════════════════════════
log('faucet : treasury…')
const treasury = await fundAccount()
await sleep(4000)
log(`treasury ${treasury.classicAddress} : ${XRP(await xrpBalance(c, treasury.classicAddress))} XRP`)

const donne = async (drops) => {
  const w = Wallet.generate()
  const r = await submit(c, { TransactionType: 'Payment', Account: treasury.classicAddress,
    Destination: w.classicAddress, Amount: String(drops) }, treasury)
  if (!r.ok) throw new Error(`activation : ${r.result}`)
  return w
}
log('activation des comptes…')
const issuer = await donne(5_000_000)
const owner = await donne(8_000_000)
const seller = await donne(30_000_000)
const member = await donne(6_000_000)
const out1 = await donne(6_000_000)     // jamais de credential
const out2 = await donne(6_000_000)     // jamais de credential, jamais aucun MPToken

log('credentials + domaine…')
await Promise.all([
  issueCredential(c, { issuer, subject: seller }),
  issueCredential(c, { issuer, subject: member }),
])
const dom = await createDomain(c, { owner, issuer })
if (!dom.domainId) throw new Error(`domaine : ${dom.result}`)

log('création des deux vaults (Subscription 75 s, Investment 900 s)…')
const VPUB = await createVault(c, owner, { subscriptionIn: 75, investmentFor: 900 })
const VPRIV = await createVault(c, owner, { subscriptionIn: 75, investmentFor: 900, domainId: dom.domainId })
if (!VPUB.vaultId || !VPRIV.vaultId) throw new Error(`vaults : ${VPUB.result} / ${VPRIV.result}`)
log(`  public ${VPUB.vaultId.slice(0, 10)}… · privé ${VPRIV.vaultId.slice(0, 10)}…`)

log('dépôts du vendeur (phase Subscription)…')
const d1 = await deposit(c, seller, VPUB.vaultId, '12000000')
const d2 = await deposit(c, seller, VPRIV.vaultId, '12000000')
if (!d1.ok || !d2.ok) throw new Error(`dépôts : ${d1.result} / ${d2.result}`)

log('MPT de numéraire CASH (émis par issuer)…')
const mi = await submit(c, { TransactionType: 'MPTokenIssuanceCreate', Account: issuer.classicAddress,
  Flags: 0x20, MaximumAmount: '1000000000' }, issuer)
const CASH = mi.meta?.AffectedNodes?.find(n => n.CreatedNode?.LedgerEntryType === 'MPTokenIssuance')
  ?.CreatedNode?.NewFields?.mpt_issuance_id ?? mi.meta?.mpt_issuance_id ?? null
if (!CASH) throw new Error(`issuance CASH illisible (${mi.result})`)
await Promise.all([
  submit(c, { TransactionType: 'MPTokenAuthorize', Account: member.classicAddress, MPTokenIssuanceID: CASH }, member),
  submit(c, { TransactionType: 'MPTokenAuthorize', Account: seller.classicAddress, MPTokenIssuanceID: CASH }, seller),
])
await submit(c, { TransactionType: 'Payment', Account: issuer.classicAddress,
  Destination: member.classicAddress, Amount: { mpt_issuance_id: CASH, value: '1000000' } }, issuer)

writeFileSync(join(ROOT, 'probes-marche', 'state-matrice.json'), JSON.stringify({
  generatedAt: new Date().toISOString(),
  vaults: { pub: VPUB.vaultId, priv: VPRIV.vaultId }, cash: CASH, domain: dom.domainId,
  seeds: Object.fromEntries(Object.entries({ treasury, issuer, owner, seller, member, out1, out2 })
    .map(([k, w]) => [k, w.seed])),
}, null, 2))

const attente = VPUB.subscriptionDate - rippleNow() + 8
if (attente > 0) { log(`attente de ${attente}s (fin de Subscription)…`); await sleep(attente * 1000) }

// ═══════════════════════════════════════════════════════════════
console.log('\n━━━━━━ VAULT PUBLIC — le marché ouvert à tous ━━━━━━\n')
// ═══════════════════════════════════════════════════════════════
{
  const v = await readVault(c, VPUB.vaultId)
  check('P1', 'XLS-65/33', 'closed-ended public : VaultKind 1, flags de parts 56, pas de DomainID',
    Number(v.VaultKind) === 1 && Number(v.shares?.Flags) === 56 && !v.shares?.DomainID && phaseOf(v) === 'Investment',
    `VaultKind=${v.VaultKind} · flags=${v.shares?.Flags} (CAN_ESCROW+CAN_TRADE+CAN_TRANSFER, sans REQUIRE_AUTH) · phase=${phaseOf(v)}`)

  const pre = await e.preflight({ vaultId: VPUB.vaultId, seller: seller.classicAddress,
    buyer: out1.classicAddress, shares: '1000000', price: '900000' })
  const pubCheck = pre.checks.find(x => x.name === 'vault public')
  check('P2', 'XLS-80', 'preflight : un acheteur SANS credential est éligible sur un vault public',
    pre.ok && Boolean(pubCheck),
    `ok=${pre.ok} · contrôle « vault public » présent=${Boolean(pubCheck)}${pre.blockers.length ? ' · blockers: ' + pre.blockers.join('|') : ''}`)

  const swap = await e.settle({ rail: 'batch', vaultId: VPUB.vaultId,
    sellerWallet: seller, buyerWallet: out1, shares: '1000000', price: '900000' })
  check('P3', 'XLS-56', 'rail batch : un inconnu achète 1 000 000 de parts pour 0,9 XRP',
    swap.stage === 'done' && swap.moved?.received === 1_000_000n,
    `stage=${swap.stage} · reçues=${swap.moved?.received} · payé=${XRP(swap.moved?.paid ?? 0)} XRP · ${swap.url ?? ''}`)

  const avant2 = await shareBalance(c, out2.classicAddress, VPUB.mptId)
  const h = await e.settle({ rail: 'htlc', vaultId: VPUB.vaultId,
    sellerWallet: seller, buyerWallet: out2, shares: '500000', price: '440000', ttl: 600 })
  const apres2 = await shareBalance(c, out2.classicAddress, VPUB.mptId)
  check('P4', 'XLS-85', 'rail htlc : 4 étapes vers un acheteur VIERGE — MPToken auto-créé',
    h.stage === 'done' && !avant2.holds && apres2.holds && apres2.amount === 500_000n,
    `stage=${h.stage} · MPToken avant=${avant2.holds} après=${apres2.holds} (${apres2.amount} parts) · secret ${h.evidence?.secretSource}`)

  // XLS-85 : la comptabilité du blocage, LockedAmount à l'aller et au retour
  const p = await htlc.propose(c, { sellerWallet: seller, buyer: member.classicAddress,
    mptId: VPUB.mptId, shares: '300000', ttl: 600 })
  const tok = (await c.request({ command: 'account_objects', account: seller.classicAddress,
    type: 'mptoken', ledger_index: 'validated' })).result.account_objects
    .find(o => o.MPTokenIssuanceID === VPUB.mptId)
  const iss = (await c.request({ command: 'ledger_entry', mpt_issuance: VPUB.mptId, ledger_index: 'validated' })).result.node
  const lockOk = Number(tok?.LockedAmount ?? 0) === 300000 && Number(iss?.LockedAmount ?? 0) === 300000
  // le refund est testé tout de suite : CancelAfter pas atteint → doit ÉCHOUER proprement…
  const tropTot = await htlc.refund(c, { wallet: seller, escrow: p })
  check('P5', 'XLS-85', 'parts en escrow : LockedAmount posé sur le MPToken ET l\'issuance, cancel avant échéance refusé',
    p.ok && lockOk && !tropTot.ok,
    `propose=${p.result} · MPToken.Locked=${tok?.LockedAmount} · issuance.Locked=${iss?.LockedAmount} · cancel prématuré=${tropTot.result}`)

  // ⚠️ l'escrow de P5 reste ouvert jusqu'à son CancelAfter (600 s) — voulu :
  // il prouve aussi qu'une offre non acceptée n'obstrue rien d'autre.

  const book = new OrderBook(join(mkdtempSync(join(tmpdir(), 'sw-mx-')), 'ob.json'))
  book.post({ vaultId: VPUB.vaultId, seller: seller.classicAddress, shares: '2000000', price: '1800000' })
  const vue = await book.viewFor(c, out1.classicAddress, VPUB.vaultId)
  check('P6', 'XLS-80', 'carnet : l\'offre publique est accessible à un compte sans credential',
    vue.length === 1 && vue[0].eligible && vue[0].covered,
    `eligible=${vue[0]?.eligible} · covered=${vue[0]?.covered} · raison="${vue[0]?.reason}"`)

  await sleep(4000)
  const hist = await priceHistory(c, VPUB.vaultId)
  const trade = hist.find(t => t.shares === '1000000' && t.price === '900000')
  const htlcVisible = hist.some(t => t.shares === '500000')
  check('P7', 'XLS-56', 'priceHistory retrouve le trade batch — et documente l\'angle mort HTLC',
    Boolean(trade) && !htlcVisible,
    `batch retrouvé=${Boolean(trade)} (0.9 drop/part) · trade HTLC visible=${htlcVisible} `
    + `(attendu: NON — un EscrowFinish n'est pas un Payment, l'historique ne le voit pas)`)

  const wd = await submit(c, { TransactionType: 'VaultWithdraw', Account: seller.classicAddress,
    VaultID: VPUB.vaultId, Amount: { mpt_issuance_id: VPUB.mptId, value: '1000000' } }, seller)
  check('P8', 'XLS-65', 'closed-ended : VaultWithdraw BLOQUÉ pendant la phase Investment',
    !wd.ok,
    `VaultWithdraw → ${wd.result} — la raison d'être du marché secondaire`)
}

// ═══════════════════════════════════════════════════════════════
console.log('\n━━━━━━ VAULT PRIVÉ — le gate à chaque porte ━━━━━━\n')
// ═══════════════════════════════════════════════════════════════
{
  const v = await readVault(c, VPRIV.vaultId)
  check('R1', 'XLS-65/80', 'closed-ended privé : flags 60, DomainID posé',
    Number(v.shares?.Flags) === 60 && v.shares?.DomainID === dom.domainId,
    `flags=${v.shares?.Flags} (REQUIRE_AUTH+…) · DomainID=${(v.shares?.DomainID ?? '').slice(0, 12)}…`)

  const pre = await e.preflight({ vaultId: VPRIV.vaultId, seller: seller.classicAddress,
    buyer: out1.classicAddress, shares: '1000000', price: '900000' })
  check('R2', 'XLS-80', 'preflight : un acheteur sans credential est BLOQUÉ avant de dépenser un drop',
    !pre.ok && pre.blockers.some(b => b.startsWith('acheteur éligible')),
    `ok=${pre.ok} · ${pre.blockers.join(' | ')}`)

  const auth = await submit(c, { TransactionType: 'MPTokenAuthorize', Account: out1.classicAddress,
    MPTokenIssuanceID: VPRIV.mptId }, out1)
  const payDirect = await submit(c, { TransactionType: 'Payment', Account: seller.classicAddress,
    Destination: out1.classicAddress, Amount: { mpt_issuance_id: VPRIV.mptId, value: '100000' } }, seller)
  check('R3', 'XLS-33/80', 'l\'autorisation n\'est pas gatée, mais le TRANSFERT l\'est',
    auth.ok && !payDirect.ok,
    `MPTokenAuthorize (non-membre)=${auth.result} · Payment de parts vers lui=${payDirect.result}`)

  const swap = await e.settle({ rail: 'batch', vaultId: VPRIV.vaultId,
    sellerWallet: seller, buyerWallet: member, shares: '1000000', price: '880000' })
  check('R4', 'XLS-56/80', 'rail batch : un MEMBRE achète (0,88 XRP, décote 12 %)',
    swap.stage === 'done' && swap.moved?.received === 1_000_000n,
    `stage=${swap.stage} · reçues=${swap.moved?.received} · ${swap.url ?? ''}`)

  const force = await e.settle({ rail: 'batch', vaultId: VPRIV.vaultId,
    sellerWallet: seller, buyerWallet: out1, shares: '100000', price: '90000', skipPreflight: true })
  check('R5', 'XLS-56', 'le « Batch menteur » : tesSUCCESS, 0 part — attrapé par la réconciliation',
    force.stage === 'silent-failure' && force.evidence?.batchResult === 'tesSUCCESS' && force.moved?.received === 0n,
    `annoncé=${force.evidence?.batchResult} · meta=${force.evidence?.metaNodes} nœud(s) · reçues=${force.moved?.received} · stage=${force.stage}`)

  let gateEscrow = null
  try {
    gateEscrow = await htlc.propose(c, { sellerWallet: seller, buyer: out1.classicAddress,
      mptId: VPRIV.mptId, shares: '100000', ttl: 600 })
  } catch (err) { gateEscrow = { ok: false, result: `exception: ${err.message}` } }
  check('R6', 'XLS-85/80', 'le gate s\'applique aussi à l\'EscrowCreate (rail htlc fermé aux exclus)',
    !gateEscrow.ok,
    `EscrowCreate de parts vers un non-membre → ${gateEscrow.result}`)

  const h = await e.settle({ rail: 'htlc', vaultId: VPRIV.vaultId,
    sellerWallet: seller, buyerWallet: member, shares: '500000', price: '430000', ttl: 600 })
  check('R7', 'XLS-85/80', 'rail htlc entre membres : 4 étapes, secret relu on-chain',
    h.stage === 'done' && h.evidence?.secretSource === 'relu on-chain',
    `stage=${h.stage} · étapes=${h.evidence?.steps?.map(s => s.result).join('/')}`)

  const book = new OrderBook(join(mkdtempSync(join(tmpdir(), 'sw-mx2-')), 'ob.json'))
  book.post({ vaultId: VPRIV.vaultId, seller: seller.classicAddress, shares: '1000000', price: '900000' })
  const vueOut = await book.viewFor(c, out1.classicAddress, VPRIV.vaultId)
  const vueMem = await book.viewFor(c, member.classicAddress, VPRIV.vaultId)
  check('R8', 'XLS-80', 'carnet : annoté pour l\'exclu, accessible pour le membre',
    vueOut[0]?.eligible === false && vueMem[0]?.eligible === true,
    `exclu: "${vueOut[0]?.reason}" · membre: "${vueMem[0]?.reason}"`)

  const cashAvant = (await shareBalance(c, seller.classicAddress, CASH)).amount
  const mptSwap = await e.settle({ rail: 'batch', vaultId: VPRIV.vaultId,
    sellerWallet: seller, buyerWallet: member, shares: '400000',
    price: { mpt_issuance_id: CASH, value: '360000' } })
  const cashApres = (await shareBalance(c, seller.classicAddress, CASH)).amount
  await sleep(4000)
  const hist = await priceHistory(c, VPRIV.vaultId)
  const mptTrade = hist.find(t => t.priceKind === 'MPT' && t.shares === '400000')
  check('R9', 'XLS-33/56', 'le prix payé en MPT (parts contre CASH) : atomique, et relu dans l\'historique',
    mptSwap.stage === 'done' && cashApres - cashAvant === 360_000n && Boolean(mptTrade),
    `stage=${mptSwap.stage} · vendeur +${cashApres - cashAvant} CASH · priceHistory: kind=${mptTrade?.priceKind} label="${mptTrade?.priceLabel}"`)

  const histXrp = hist.find(t => t.priceKind === 'XRP' && t.shares === '1000000')
  check('R10', 'XLS-56', 'priceHistory du vault privé : les deux numéraires cohabitent',
    Boolean(histXrp) && Boolean(mptTrade),
    `XRP=${histXrp?.price} drops · MPT=${mptTrade?.priceAmount?.value} CASH · price(compat)=${mptTrade?.price} (null attendu hors XRP)`)
}

// ═══════════════════════════════════════════════════════════════
console.log(`\n━━━━━━ RÉCAPITULATIF (${table.length} contrôles) ━━━━━━\n`)
for (const r of table)
  console.log(`  ${r.ok ? '✅' : '❌'} ${r.id.padEnd(4)} ${r.norme.padEnd(10)} ${r.quoi}`)
console.log(`\n${echecs === 0
  ? `✅ matrice complète : ${table.length}/${table.length} — le câblage MPT tient sur les deux familles de vaults.`
  : `❌ ${echecs} contrôle(s) en écart — voir le détail ci-dessus.`}\n`)
console.log(`décor conservé dans probes-marche/state-matrice.json (gitignoré)`)
await c.disconnect()
process.exit(echecs === 0 ? 0 : 1)
