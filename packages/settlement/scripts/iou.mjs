/**
 * Prix payé en IOU — le rail batch avec un autre numéraire que l'XRP.
 *
 *   node packages/settlement/scripts/iou.mjs        (~2 minutes)
 *
 * A. LE PIÈGE   une trustline ouverte AVANT que l'émetteur n'active le
 *               rippling : le preflight doit le voir. Sans lui, la jambe du
 *               prix meurt en `tecPATH_DRY` — et dans un Batch, cela donne
 *               `tesSUCCESS` avec une meta à un nœud. Trois échecs silencieux
 *               d'affilée ont été payés pour apprendre ça.
 * B. RÉPARATION `TrustSet tfClearNoRipple` par l'émetteur, ligne par ligne
 *               (`asfDefaultRipple` ne rattrape PAS les lignes existantes).
 * C. NOMINAL    l'échange se règle en SWD et se relit dans `priceHistory`
 *               avec son numéraire.
 *
 * L'émetteur est créé pour ce script (aucun faucet : activé par un Payment) et
 * son seed est écrit dans probes-marche/state-rails.json, gitignoré.
 */
import { SettlementEngine, checkPaymentMeans, normalizeAmount } from '@secondwave/settlement'
import { priceHistory } from '@secondwave/orderbook'
import {
  connect, Wallet, submit, scene, XRP, titre, montrer, sleep, sauverEtat, lireEtat,
} from './_decor.mjs'

const c = await connect()
const e = new SettlementEngine(c)
const s = await scene(c, 'sain')
let echecs = 0
const verdict = (cond, quoi, detail = '') => {
  if (!cond) echecs++
  console.log(`  ${cond ? '✅' : '❌'} ${quoi}${detail ? ' — ' + detail : ''}`)
}
const CUR = 'SWD'

// ── Décor : un émetteur à nous, sans DefaultRipple pour l'instant ──
const garde = lireEtat('rails')
let issuer
if (garde?.iouIssuerSeed) {
  issuer = Wallet.fromSeed(garde.iouIssuerSeed)
  console.log(`émetteur réutilisé ${issuer.classicAddress}`)
} else {
  issuer = Wallet.generate()
  const pay = await submit(c, {
    TransactionType: 'Payment', Account: s.seller.classicAddress,
    Destination: issuer.classicAddress, Amount: '8000000',
  }, s.seller)
  if (!pay.ok) { console.error(`activation de l'émetteur impossible : ${pay.result}`); process.exit(1) }
  sauverEtat('rails', { ...(garde ?? {}), iouIssuerSeed: issuer.seed, iouIssuer: issuer.classicAddress, currency: CUR })
  console.log(`émetteur créé ${issuer.classicAddress} (seed dans probes-marche/state-rails.json)`)
}

const ligne = (w, limite = '10000') => submit(c, {
  TransactionType: 'TrustSet', Account: w.classicAddress,
  LimitAmount: { currency: CUR, issuer: issuer.classicAddress, value: limite },
}, w)

// ═══════════════════════════════════════════════════════════════
titre('A · LE PIÈGE — trustlines ouvertes avant le rippling')

// ⚠️ Le piège ne se rejoue qu'avec un émetteur VIERGE : une fois DefaultRipple
//    posé (première exécution), les lignes suivantes naissent ouvertes. On le
//    détecte et on saute la démonstration au lieu de compter un faux écart.
const flagsIssuer = Number((await c.request({ command: 'account_info',
  account: issuer.classicAddress, ledger_index: 'validated' })).result.account_data.Flags ?? 0)
const dejaRepare = Boolean(flagsIssuer & 0x00800000)          // lsfDefaultRipple
if (dejaRepare) console.log('  ℹ️  émetteur déjà réparé (DefaultRipple posé) — piège non rejouable, sections A/B en constat seul\n')

const l1 = await ligne(s.buyer), l2 = await ligne(s.seller)
console.log(`  trustline acheteur ${l1.result} · vendeur ${l2.result}`)
const emis = await submit(c, {
  TransactionType: 'Payment', Account: issuer.classicAddress,
  Destination: s.buyer.classicAddress, Amount: { currency: CUR, issuer: issuer.classicAddress, value: '100' },
}, issuer)
console.log(`  100 ${CUR} émis vers l'acheteur : ${emis.result}`)

const prix = { currency: CUR, issuer: issuer.classicAddress, value: '5' }
const avantRepair = await checkPaymentMeans(c, {
  payer: s.buyer.classicAddress, payee: s.seller.classicAddress, amount: prix,
})
for (const ch of avantRepair) console.log(`    ${ch.ok ? '✅' : '⛔'} ${ch.name} — ${ch.detail}`)
const piege = avantRepair.find(x => x.name.startsWith('rippling'))
if (dejaRepare) console.log('  ℹ️  piège sauté (émetteur déjà réparé)')
else verdict(piege && !piege.ok, 'le preflight voit le NoRipple de l\'émetteur AVANT de dépenser un drop')

// ═══════════════════════════════════════════════════════════════
titre('B · RÉPARATION — tfClearNoRipple, ligne par ligne')

const df = await submit(c, { TransactionType: 'AccountSet', Account: issuer.classicAddress, SetFlag: 8 }, issuer)
console.log(`  asfDefaultRipple sur l'émetteur : ${df.result}`)
const encore = await checkPaymentMeans(c, { payer: s.buyer.classicAddress, payee: s.seller.classicAddress, amount: prix })
const tjs = encore.find(x => x.name.startsWith('rippling'))
console.log(`  après asfDefaultRipple : rippling ${tjs?.ok ? 'ouvert' : 'TOUJOURS bloqué'}`)
if (dejaRepare) console.log('  ℹ️  démonstration sautée (lignes nées ouvertes)')
else verdict(tjs && !tjs.ok, 'asfDefaultRipple ne rattrape PAS les lignes déjà ouvertes',
  'c\'est exactement le piège qui coûte trois soumissions')

for (const peer of [s.buyer.classicAddress, s.seller.classicAddress]) {
  const r = await submit(c, {
    TransactionType: 'TrustSet', Account: issuer.classicAddress,
    LimitAmount: { currency: CUR, issuer: peer, value: '0' }, Flags: 0x00040000,   // tfClearNoRipple
  }, issuer)
  console.log(`  tfClearNoRipple → ${peer.slice(0, 10)}… : ${r.result}`)
}
const repare = await checkPaymentMeans(c, { payer: s.buyer.classicAddress, payee: s.seller.classicAddress, amount: prix })
for (const ch of repare) console.log(`    ${ch.ok ? '✅' : '⛔'} ${ch.name} — ${ch.detail}`)
verdict(repare.every(x => x.ok), 'toutes les vérifications du numéraire passent')

// ═══════════════════════════════════════════════════════════════
titre(`C · NOMINAL — 400 000 parts contre 5 ${CUR}`)

const r = await e.settle({
  rail: 'batch', vaultId: s.vaultId,
  sellerWallet: s.seller, buyerWallet: s.buyer,
  shares: '400000', price: prix,
})
for (const ch of r.preflight?.checks ?? [])
  console.log(`    ${ch.ok === true ? '✅' : ch.ok === false ? '⛔' : '❔'} ${ch.name} — ${ch.detail}`)
console.log()
console.log(`  parts   vendeur ${r.before?.sellerShares} → ${r.after?.sellerShares}`)
console.log(`          acheteur ${r.before?.buyerShares} → ${r.after?.buyerShares}`)
console.log(`  ${CUR}     acheteur ${r.before?.buyerPrice.value} → ${r.after?.buyerPrice.value}`)
console.log(`          vendeur  ${r.before?.sellerPrice.value} → ${r.after?.sellerPrice.value}`)
console.log(`  prix    ${r.priceLabel}`)
console.log(`  jambes  ${r.evidence?.legs?.map(l => `${l.type}=${l.result}`).join(' · ')}`)
console.log(`  ${r.url ?? ''}`)
verdict(r.stage === 'done', 'le swap payé en IOU est réconcilié', r.stage)
verdict(Number(r.moved?.collected) === 5, `le vendeur a bien encaissé 5 ${CUR}`, `${r.moved?.collected}`)

// ── L'historique doit reconnaître le numéraire ───────────────
await sleep(4000)
const trades = await priceHistory(c, s.vaultId)
const dernier = trades.filter(t => t.priceKind).slice(-3)
console.log(`\n  priceHistory — les 3 derniers échanges avec prix :`)
for (const t of dernier)
  console.log(`    L${t.ledgerIndex} ${t.shares} parts · ${t.priceKind.padEnd(3)} ${t.priceLabel}`)
const iouTrade = trades.find(t => t.priceKind === 'IOU' && t.shares === '400000')
verdict(Boolean(iouTrade), 'l\'échange en IOU est relu depuis la chaîne avec son numéraire')
verdict(iouTrade?.price === null && iouTrade?.priceAmount?.currency === CUR,
  '`price` reste en drops (compat) et `priceAmount` porte l\'IOU',
  `price=${iouTrade?.price} priceAmount=${JSON.stringify(iouTrade?.priceAmount)}`)

console.log(`\n${echecs === 0 ? '✅ moyens de paiement : IOU de bout en bout.' : `❌ ${echecs} écart(s).`}\n`)
await c.disconnect()
process.exit(echecs === 0 ? 0 : 1)
