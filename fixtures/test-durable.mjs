/**
 * fixtures/test-durable.mjs — test d'INTÉGRATION du rail durable.
 *
 *   node fixtures/test-durable.mjs      (nécessite le Devnet + le faucet)
 *
 * Ce que le rail promet, et qu'on vérifie ici de bout en bout sur un vrai
 * vault privé, avec de vraies parts MPT :
 *
 *   1. le vendeur publie          rien n'est signé, rien n'est engagé
 *   2. l'acheteur s'engage        BatchSigners posés, l'offre attend
 *   3. LES DEUX COMPTES BOUGENT   l'offre doit survivre — c'est tout l'enjeu
 *   4. le vendeur confirme        signature de l'enveloppe, soumission
 *   5. les parts ont bougé        réconciliation des soldes, seule preuve
 *
 * Puis le bouton « Annuler », sur une seconde offre :
 *   6. le vendeur annule          ticket consommé
 *   7. l'offre est insoumettable  tefNO_TICKET
 *
 * ⚠️ ~4 min (attente de la phase Investment).
 */
import { connect, fundAccount, sleep, shareBalance, xrpBalance, submit } from '@secondwave/core'
import { issueCredential, createDomain, createVault, deposit, waitForInvestment } from '@secondwave/vault'
import {
  ensureTickets, TICKETS_SELLER, ticketsBuyer,
  buildOffer, signAsBuyer, signAsSeller, submitOffer, cancelOffer, offerAlive,
} from '@secondwave/settlement'
import { OrderBook, STATUS } from '@secondwave/orderbook'
import { join } from 'node:path'
import { rmSync } from 'node:fs'

const XRP = n => String(Math.round(n * 1_000_000))
let fails = 0
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? '✅' : '❌'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) fails++
}

const BOOK = join(process.cwd(), 'orderbook-test-durable.json')
rmSync(BOOK, { force: true })
const book = new OrderBook(BOOK)

const c = await connect()

// ── 1. Décor : un vault privé, deux membres, le vendeur détient des parts ──
console.log('\n━━━ 1. Décor ━━━')
const issuer = await fundAccount()
const seller = await fundAccount()
const buyer = await fundAccount()
await sleep(5000)

await Promise.all([issueCredential(c, { issuer, subject: seller }), issueCredential(c, { issuer, subject: buyer })])
const dom = await createDomain(c, { owner: issuer, issuer })
check('domaine permissionné', Boolean(dom.domainId), dom.result)

const v = await createVault(c, seller, { subscriptionIn: 75, investmentFor: 900, domainId: dom.domainId })
check('VaultCreate closed-ended privé', Boolean(v.vaultId), v.result)

const dep = await deposit(c, seller, v.vaultId, XRP(30))
check('le vendeur dépose 30 XRP', dep.ok, dep.result)

const soldeInitial = await shareBalance(c, seller.classicAddress, v.mptId)
check('le vendeur détient des parts', soldeInitial.amount > 0n, `${soldeInitial.amount} parts`)

console.log('\n   attente de la phase Investment (le capital est verrouillé)…')
await waitForInvestment(v)

// ── 2. Le vendeur publie ──────────────────────────────────────────────────
console.log('\n━━━ 2. Le vendeur publie — aucune signature ━━━')
const tS = await ensureTickets(c, seller, TICKETS_SELLER)
check('tickets du vendeur', tS.free.length >= TICKETS_SELLER, tS.free.slice(0, 2).join(', '))
const sellerTickets = tS.free.slice(0, TICKETS_SELLER)

const PARTS = (soldeInitial.amount / 2n).toString()
const PRIX = XRP(12)
const o1 = book.post({
  vaultId: v.vaultId, seller: seller.classicAddress,
  shares: PARTS, price: PRIX, ttl: null, sellerTickets,
})
check('offre publiée, sans expiration', o1.status === STATUS.OPEN && o1.expiry === null, o1.id)

// ── 3. L'acheteur s'engage ────────────────────────────────────────────────
console.log('\n━━━ 3. L\'acheteur s\'engage ━━━')
const bal = await shareBalance(c, buyer.classicAddress, v.mptId)
const needsAuthorize = !bal.holds
const tB = await ensureTickets(c, buyer, ticketsBuyer(needsAuthorize))
const buyerTickets = tB.free.slice(0, ticketsBuyer(needsAuthorize))
check('tickets de l\'acheteur', buyerTickets.length === ticketsBuyer(needsAuthorize), buyerTickets.join(', '))

let batch = buildOffer({
  sellerAddress: seller.classicAddress, buyerAddress: buyer.classicAddress,
  mptId: v.mptId, shares: PARTS, price: PRIX,
  sellerTickets, buyerTickets, needsAuthorize,
})
check('enveloppe sans LastLedgerSequence', batch.LastLedgerSequence === undefined)
signAsBuyer(batch, buyer)
check('BatchSigners posés', Array.isArray(batch.BatchSigners) && batch.BatchSigners.length === 1)
book.match(o1.id, { buyer: buyer.classicAddress, batch })

// Le carnet passe par un fichier JSON : on vérifie que l'aller-retour ne casse rien.
batch = JSON.parse(JSON.stringify(batch))

// ── 4. LA VIE CONTINUE — l'offre doit survivre ────────────────────────────
console.log('\n━━━ 4. Les deux comptes transigent ailleurs ━━━')
const bruitS = await submit(c, { TransactionType: 'AccountSet', Account: seller.classicAddress }, seller)
const bruitB = await submit(c, { TransactionType: 'AccountSet', Account: buyer.classicAddress }, buyer)
check('le vendeur a transigé', bruitS.ok, bruitS.result)
check('l\'acheteur a transigé', bruitB.ok, bruitB.result)
check('l\'offre est toujours vivante', await offerAlive(c, batch))

// ── 5. Le vendeur confirme, bien plus tard ────────────────────────────────
console.log('\n━━━ 5. Le vendeur confirme ━━━')
const avant = {
  vendeurParts: (await shareBalance(c, seller.classicAddress, v.mptId)).amount,
  acheteurParts: (await shareBalance(c, buyer.classicAddress, v.mptId)).amount,
  vendeurXrp: await xrpBalance(c, seller.classicAddress),
}
signAsSeller(batch, seller)
book.confirm(o1.id, batch)
const r = await submitOffer(c, batch)
check('Batch soumis et validé', r.ok, `${r.stage} ${r.batchResult ?? r.message ?? ''}`)
if (r.evidence) console.log(`     jambes : ${r.evidence.legs.map(l => `${l.type}:${l.result}`).join(' · ')}`)

const apres = {
  vendeurParts: (await shareBalance(c, seller.classicAddress, v.mptId)).amount,
  acheteurParts: (await shareBalance(c, buyer.classicAddress, v.mptId)).amount,
  vendeurXrp: await xrpBalance(c, seller.classicAddress),
}
check('les parts ont bougé', apres.acheteurParts - avant.acheteurParts === BigInt(PARTS),
  `acheteur ${avant.acheteurParts} → ${apres.acheteurParts}`)
check('le vendeur a cédé ses parts', avant.vendeurParts - apres.vendeurParts === BigInt(PARTS))
check('le vendeur a été payé', apres.vendeurXrp > avant.vendeurXrp,
  `+${apres.vendeurXrp - avant.vendeurXrp} drops`)
if (r.ok) book.fill(o1.id, r.hash)
check('carnet à jour', book.get(o1.id).status === STATUS.FILLED)

// ── 6-7. Le bouton « Annuler » ────────────────────────────────────────────
console.log('\n━━━ 6. Une seconde offre, que le vendeur annule ━━━')
const tS2 = await ensureTickets(c, seller, TICKETS_SELLER, { reserved: sellerTickets })
const sellerTickets2 = tS2.free.filter(t => !sellerTickets.includes(t)).slice(0, TICKETS_SELLER)
const tB2 = await ensureTickets(c, buyer, 1, { reserved: buyerTickets })
const buyerTickets2 = tB2.free.filter(t => !buyerTickets.includes(t)).slice(0, 1)

const reste = (await shareBalance(c, seller.classicAddress, v.mptId)).amount
const o2 = book.post({
  vaultId: v.vaultId, seller: seller.classicAddress,
  shares: reste.toString(), price: XRP(10), ttl: null, sellerTickets: sellerTickets2,
})
const batch2 = buildOffer({
  sellerAddress: seller.classicAddress, buyerAddress: buyer.classicAddress,
  mptId: v.mptId, shares: reste.toString(), price: XRP(10),
  sellerTickets: sellerTickets2, buyerTickets: buyerTickets2, needsAuthorize: false,
})
signAsBuyer(batch2, buyer)
signAsSeller(batch2, seller)          // pire cas : tout est signé, prêt à partir
book.match(o2.id, { buyer: buyer.classicAddress, batch: batch2 })
console.log('   offre entièrement signée par les deux parties.')

const annul = await book.cancelDurable(c, seller, o2.id, { cancelOffer })
check('le vendeur clique « annuler »', annul.ok && annul.onChain, `ticket ${annul.ticket}`)
check('le carnet marque annulé', book.get(o2.id).status === STATUS.CANCELLED)

console.log('\n━━━ 7. L\'offre annulée est-elle vraiment morte ? ━━━')
const rejeu = await submitOffer(c, batch2)
check('rejouer le Batch signé échoue', !rejeu.ok, rejeu.engineResult ?? rejeu.stage)
check('le motif est bien le ticket', /tefNO_TICKET/.test(`${rejeu.engineResult} ${rejeu.message}`),
  rejeu.engineResult ?? '')
check('les parts n\'ont pas bougé',
  (await shareBalance(c, seller.classicAddress, v.mptId)).amount === reste)

// ── Verdict ───────────────────────────────────────────────────────────────
rmSync(BOOK, { force: true })
console.log(`\n${fails ? `❌ ${fails} échec(s)` : '✅ rail durable vérifié de bout en bout'}\n`)
await c.disconnect()
process.exit(fails ? 1 : 0)
