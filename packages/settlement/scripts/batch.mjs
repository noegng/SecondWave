/**
 * Rail « batch » sur la chaîne — le chemin nominal et un chemin d'échec.
 *
 *   node packages/settlement/scripts/batch.mjs
 *
 * A. NOMINAL   un membre cède 1 000 000 de parts contre 0,88 XRP.
 * B. ÉCHEC     un acheteur à UN DROP sous le seuil de réserve :
 *              · le preflight le refuse — c'est le correctif ;
 *              · forcé, le Batch répond `tesSUCCESS` et rien ne bouge.
 *
 * Les soldes avant/après sont imprimés dans les deux cas : sur un Batch, le
 * code de retour ne veut rien dire.
 */
import { SettlementEngine, buyerSolvency, readReserve, accountFootprint } from '@secondwave/settlement'
import {
  connect, scene, nouveauMembre, XRP, titre, montrer, sleep, shareBalance, xrpBalance,
} from './_decor.mjs'

const c = await connect()
const e = new SettlementEngine(c)
const s = await scene(c, 'sain')
let echecs = 0
const verdict = (attendu, obtenu, quoi) => {
  const ok = attendu === obtenu
  if (!ok) echecs++
  console.log(`  ${ok ? '✅' : '❌'} ${quoi} : attendu « ${attendu} », obtenu « ${obtenu} »`)
}

console.log(`vault    ${s.key} — ${s.vaultId.slice(0, 24)}…`)
console.log(`vendeur  ${s.seller.classicAddress} · ${s.sellerShares} parts`)
console.log(`acheteur ${s.buyer.classicAddress} · ${s.buyerShares} parts`)

// ═══════════════════════════════════════════════════════════════
titre('A · CHEMIN NOMINAL — 1 000 000 de parts contre 0,88 XRP')

const r = await e.settle({
  rail: 'batch', vaultId: s.vaultId,
  sellerWallet: s.seller, buyerWallet: s.buyer,
  shares: '1000000', price: '880000',
})

for (const ch of r.preflight?.checks ?? [])
  console.log(`    ${ch.ok === true ? '✅' : ch.ok === false ? '⛔' : '❔'} ${ch.name} — ${ch.detail}`)
console.log()
montrer('avant', r.before)
montrer('après', r.after)
console.log(`\n  déplacé   : ${r.moved?.shares} parts · payé ${XRP(r.moved?.paid ?? 0)} XRP`)
console.log(`  prix      : ${r.priceLabel}`)
console.log(`  jambes    : ${r.evidence?.legs?.map(l => `${l.type}=${l.result}`).join(' · ') ?? '—'}`)
console.log(`  meta      : ${r.evidence?.metaNodes} nœud(s) — le Batch lui-même n'en montre qu'un`)
console.log(`  coût      : ${r.cost?.fees} drops de frais · ${r.cost?.reserveLocked} drops de réserve immobilisés`)
console.log(`  ${r.url ?? ''}`)
verdict('done', r.stage, 'le swap nominal')

// ═══════════════════════════════════════════════════════════════
titre('B · CHEMIN D\'ÉCHEC — un acheteur à UN DROP sous le seuil')

// Un membre neuf, sans objet MPToken : le swap devra en créer un (+0,2 XRP).
const pauvre = await nouveauMembre(c, s.seller, '3000000')
await sleep(3000)
const res = await readReserve(c)
const foot = await accountFootprint(c, pauvre.classicAddress)
const PARTS = '10000'

// Prix calculé pour qu'il reste EXACTEMENT un drop de moins que la réserve due.
const besoin = buyerSolvency({
  balance: foot.balance, ownerCount: foot.ownerCount, priceDrops: 0n, newObjects: 1, reserve: res,
}).reserveRequired
const prixTropCher = foot.balance - besoin + 1n

console.log(`  acheteur ${pauvre.classicAddress}`)
console.log(`    solde        ${XRP(foot.balance)} XRP · OwnerCount ${foot.ownerCount}`)
console.log(`    réserve due  ${XRP(besoin)} XRP (base ${XRP(res.base)} + ${XRP(res.inc)} × ${foot.ownerCount}+1 objet MPToken)`)
console.log(`    prix demandé ${XRP(prixTropCher)} XRP — il resterait ${XRP(besoin - 1n)} XRP, soit 1 drop de trop peu\n`)

// B1 — le preflight doit refuser AVANT de dépenser un drop.
const bloque = await e.settle({
  rail: 'batch', vaultId: s.vaultId,
  sellerWallet: s.seller, buyerWallet: pauvre,
  shares: PARTS, price: prixTropCher.toString(),
})
for (const b of bloque.blockers ?? []) console.log(`    ⛔ ${b}`)
verdict('preflight', bloque.stage, 'le preflight arrête l\'échange')

// B2 — forcé, le rail ment : tesSUCCESS et rien ne bouge.
const avantParts = (await shareBalance(c, pauvre.classicAddress, s.mptId)).amount
const avantXrp = await xrpBalance(c, pauvre.classicAddress)
const force = await e.settle({
  rail: 'batch', vaultId: s.vaultId,
  sellerWallet: s.seller, buyerWallet: pauvre,
  shares: PARTS, price: prixTropCher.toString(), skipPreflight: true,
})
const apresParts = (await shareBalance(c, pauvre.classicAddress, s.mptId)).amount
const apresXrp = await xrpBalance(c, pauvre.classicAddress)

console.log(`\n  preflight court-circuité :`)
console.log(`    annoncé par le Batch : ${force.evidence?.batchResult ?? force.engineResult}`)
console.log(`    meta                 : ${force.evidence?.metaNodes} nœud(s)`)
console.log(`    parts reçues         : ${apresParts - avantParts}`)
console.log(`    XRP dépensés         : ${XRP(avantXrp - apresXrp)}`)
if (force.warning) console.log(`    ⚠️  ${force.warning}`)
verdict('silent-failure', force.stage, 'la réconciliation démasque l\'échec silencieux')

console.log(`\n${echecs === 0 ? '✅ rail batch : les deux chemins se comportent comme mesuré.' : `❌ ${echecs} écart(s).`}\n`)
await c.disconnect()
process.exit(echecs === 0 ? 0 : 1)
