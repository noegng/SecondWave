/**
 * probes-marche/09-prix.mjs — Campagne E : découverte de prix et historique.
 *
 *   node probes-marche/09-prix.mjs
 *
 * E40  5 échanges à prix distincts → priceHistory les retrouve tous, dans l'ordre
 * E41  prix payé en IOU (USD) puis en MPT (CASH) — le Batch passe-t-il ?
 *      priceHistory les voit-il ? (il ne lit que l'XRP)
 * E42  donation (transfert sans contrepartie) — prix nul ou exclu ?
 * E43  échange en DEUX transactions séparées, hors Batch, ledgers différents
 * E45  décote implicite : prix payé ÷ NAV par part
 * E46  courbe de décote en s'approchant de RedemptionDate (vault court dédié)
 * H63  le vendeur RETIRE ses parts (VaultWithdraw en Redemption) entre la
 *      signature de l'acheteur et la soumission — enveloppe ACHETEUR (le cas dangereux)
 */
import {
  connect, submit, sequence, shareBalance, xrpBalance, sleep, rippleNow,
  loadState, walletsOf, recap, XRP, sendRaw, swapBatch, batchEnvelope,
  signEnvelope, signMultiBatch, createVaultFlags, photo, diffPhoto,
} from './_lib.mjs'
import { priceHistory } from '@secondwave/orderbook'
import { deposit } from '@secondwave/vault'
import { readVault } from '@secondwave/core'

const S = loadState('marche')
const W = walletsOf(S)
const c = await connect()
const V1 = S.vaults.V1, V5 = S.vaults.V5
const R = []
const note = (cas, question, reponse, verdict) => { R.push({ cas, question, reponse, verdict }); console.log(`  [${cas}] ${reponse}\n        → ${verdict}`) }

// V6 : vault court PUBLIC pour la courbe de décote — créé tout de suite,
// les phases avancent pendant qu'on mesure E40–E45.
console.log('── création du vault court V6 (public, Investment 300 s)…')
const V6 = await createVaultFlags(c, W.owner, { subscriptionIn: 45, investmentFor: 300 })
const dep6 = await deposit(c, W.seller1, V6.vaultId, '10000000')
console.log(`   V6 ${V6.ok ? '✅' : V6.result} · dépôt ${dep6.result} · redemption à T+${V6.redemptionDate - rippleNow()}s`)

console.log('\n══ E40 · 5 échanges à prix distincts sur V5 ══')
{
  const PRICES = [880_000, 850_000, 910_000, 800_000, 870_000]   // pour 1 000 000 parts
  for (const p of PRICES) {
    const b = await swapBatch(c, { seller: W.seller2, buyer: W.buyer1, mptId: V5.mptId,
      shares: 1_000_000, price: p })
    const r = await sendRaw(c, b)
    console.log(`    prix ${XRP(p)} XRP/M : ${r.engine}→${r.validated}`)
  }
  // E42 : une donation au milieu de l'historique
  const don = await submit(c, { TransactionType: 'Payment', Account: W.seller2.classicAddress,
    Destination: W.buyer1.classicAddress, Amount: { mpt_issuance_id: V5.mptId, value: '333333' } }, W.seller2)
  console.log(`    donation 333333 parts : ${don.result}`)

  // E43 : deux transactions séparées, ledgers différents
  const t1 = await submit(c, { TransactionType: 'Payment', Account: W.seller2.classicAddress,
    Destination: W.buyer1.classicAddress, Amount: { mpt_issuance_id: V5.mptId, value: '500000' } }, W.seller2)
  await sleep(8000)                                            // au moins un ledger d'écart
  const t2 = await submit(c, { TransactionType: 'Payment', Account: W.buyer1.classicAddress,
    Destination: W.seller2.classicAddress, Amount: '430000' }, W.buyer1)
  console.log(`    jambes séparées : parts ${t1.result} · prix ${t2.result} (ledgers différents)`)

  await sleep(4000)
  const h = await priceHistory(c, V5.vaultId)
  console.log(`\n    priceHistory(V5) — ${h.length} transferts relus :`)
  for (const t of h)
    console.log(`      L${t.ledgerIndex} ${t.shares} parts · prix ${t.price ?? 'introuvable'} ${t.pricePerShare ? '(' + t.pricePerShare.toFixed(3) + ' drop/part)' : ''}`)
  const trades = h.filter(t => t.price !== null)
  const wantedFound = PRICES.every(p => trades.some(t => t.price === String(p)))
  const ordered = h.every((t, i) => i === 0 || t.ledgerIndex >= h[i - 1].ledgerIndex)
  note('E40', '5 échanges retrouvés, dans l\'ordre, aux bons prix',
    `${trades.length} trades avec prix · 5 prix attendus ${wantedFound ? 'tous retrouvés' : 'MANQUANTS'} · ordre ledger ${ordered ? 'croissant' : 'DÉSORDONNÉ'}`,
    wantedFound && ordered ? 'l\'historique on-chain est complet et fidèle' : 'trou dans la relecture')
  const don1 = h.find(t => t.shares === '333333')
  note('E42', 'donation : exclue ou prix nul ?',
    `présente avec price=${don1?.price ?? 'null'} pricePerShare=${don1?.pricePerShare ?? 'null'}`,
    don1?.price === null ? 'affichée à prix introuvable (null) — pas de faux zéro qui polluerait une moyenne' : 'vérifier')
  const split = h.find(t => t.shares === '500000')
  note('E43', 'échange en 2 tx hors Batch (ledgers différents)',
    `transfert vu, price=${split?.price ?? 'null'}`,
    split?.price === null ? 'LIMITE : counterLeg ne regarde que le même ledger — un règlement différé est invisible' : 'recollé quand même')
}

console.log('\n══ E41 · Prix en IOU (USD) puis en MPT (CASH) ══')
{
  // a) IOU
  const iou = { currency: 'USD', issuer: S.iou.issuer, value: '5' }
  const b1 = await swapBatch(c, { seller: W.seller1, buyer: W.buyer2, mptId: V1.mptId,
    shares: 400_000, price: 0, priceAmount: iou, authorize: true })
  const r1 = await sendRaw(c, b1)
  await sleep(2000)
  const got1 = (await shareBalance(c, W.buyer2.classicAddress, V1.mptId)).amount
  console.log(`    parts contre 5 USD : ${r1.engine}→${r1.validated} · buyer2 détient ${got1} parts`)

  // b) MPT contre MPT
  const cash = { mpt_issuance_id: S.cashMpt, value: '360000' }
  const b2 = await swapBatch(c, { seller: W.seller1, buyer: W.buyer2, mptId: V1.mptId,
    shares: 400_000, price: 0, priceAmount: cash })
  const r2 = await sendRaw(c, b2)
  await sleep(2000)
  const got2 = (await shareBalance(c, W.buyer2.classicAddress, V1.mptId)).amount
  const cashSeller = (await shareBalance(c, W.seller1.classicAddress, S.cashMpt)).amount
  console.log(`    parts contre CASH  : ${r2.engine}→${r2.validated} · buyer2 détient ${got2} · seller1 a ${cashSeller} CASH`)

  const h = await priceHistory(c, V1.vaultId, { maxPages: 10 })
  const iouTrade = h.find(t => t.shares === '400000' && t.buyer === W.buyer2.classicAddress)
  note('E41', 'swap dont le prix est un IOU / un MPT',
    `IOU: ${r1.validated ?? r1.engine} · MPT↔MPT: ${r2.validated ?? r2.engine} · priceHistory sur ces trades: price=${iouTrade?.price ?? 'null'}`,
    (r1.validated === 'tesSUCCESS' && got1 >= 400_000n)
      ? 'le Batch règle en n\'importe quel numéraire — mais priceHistory (XRP only) est AVEUGLE à ces prix : trou de couverture'
      : 'voir codes')
}

console.log('\n══ E45 · Décote implicite vs NAV ══')
{
  const v = await readVault(c, V5.vaultId)
  const nav = Number(v.AssetsTotal) / Number(v.shares.OutstandingAmount)
  const h = (await priceHistory(c, V5.vaultId)).filter(t => t.price !== null)
  const decotes = h.map(t => (1 - t.pricePerShare / nav) * 100)
  const avg = decotes.reduce((s, d) => s + d, 0) / decotes.length
  note('E45', 'décote implicite = 1 − prix/NAV',
    `NAV ${nav.toFixed(4)} drop/part · décotes ${decotes.map(d => d.toFixed(1) + '%').join(' ')} · moyenne ${avg.toFixed(1)}%`,
    'sur un vault SANS prêt la décote est un pur prix de l\'illiquidité choisi par les contreparties')
}

console.log('\n══ E46 · Courbe de décote en approchant RedemptionDate (V6) ══')
{
  const points = []
  const investEnd = V6.redemptionDate
  const buyers = [W.buyer1, W.buyer2]
  let i = 0
  // 4 échanges espacés jusqu'à ~30 s de la redemption, décote qui se resserre
  for (const frac of [0.965, 0.975, 0.985, 0.992]) {
    const left = investEnd - rippleNow()
    if (left < 25) break
    const price = Math.round(500_000 * frac)
    const buyer = buyers[i++ % 2]
    const b = await swapBatch(c, { seller: W.seller1, buyer, mptId: V6.mptId,
      shares: 500_000, price, authorize: !(await shareBalance(c, buyer.classicAddress, V6.mptId)).holds })
    const r = await sendRaw(c, b)
    points.push({ tMinus: investEnd - rippleNow(), price, ok: r.validated === 'tesSUCCESS' })
    console.log(`    T−${String(investEnd - rippleNow()).padStart(3)}s · prix ${frac} × NAV : ${r.engine}→${r.validated}`)
    const wait = 45 - (investEnd - rippleNow()) % 45
    if (investEnd - rippleNow() > 70) await sleep(35_000)
  }
  const h = (await priceHistory(c, V6.vaultId)).filter(t => t.price !== null)
  note('E46', 'courbe de décote reconstruite depuis la chaîne',
    h.map(t => `L${t.ledgerIndex}:${(t.pricePerShare).toFixed(3)}`).join(' → '),
    'close_time + prix relus suffisent à tracer décote(t) — la convergence vers la NAV est mesurable on-chain')
}

console.log('\n══ H63 · VaultWithdraw entre signature et soumission (enveloppe ACHETEUR) ══')
{
  // Attendre la phase Redemption de V6.
  const wait = V6.redemptionDate - rippleNow() + 8
  if (wait > 0) { console.log(`    attente Redemption de V6 : ${wait}s…`); await sleep(wait * 1000) }

  const sellerShares = (await shareBalance(c, W.seller1.classicAddress, V6.mptId)).amount
  console.log(`    parts restantes du vendeur : ${sellerShares}`)
  // Batch ENVELOPPE ACHETEUR : la séquence du vendeur n'est PAS celle de l'enveloppe.
  const sSeq = await sequence(c, W.seller1.classicAddress)
  const bSeq = await sequence(c, W.buyer1.classicAddress)
  const legs = [
    { TransactionType: 'Payment', Account: W.seller1.classicAddress, Destination: W.buyer1.classicAddress,
      Amount: { mpt_issuance_id: V6.mptId, value: sellerShares.toString() }, Sequence: sSeq },
    { TransactionType: 'Payment', Account: W.buyer1.classicAddress, Destination: W.seller1.classicAddress,
      Amount: '4000000', Sequence: bSeq + 1 },
  ]
  const b = await batchEnvelope(c, W.buyer1.classicAddress, legs, { seq: bSeq })
  signMultiBatch(W.seller1, b)
  signEnvelope(b, W.buyer1)

  // Le vendeur retire TOUT en phase Redemption (consomme sSeq et vide les parts).
  const wd = await submit(c, { TransactionType: 'VaultWithdraw', Account: W.seller1.classicAddress,
    VaultID: V6.vaultId, Amount: { mpt_issuance_id: V6.mptId, value: sellerShares.toString() } }, W.seller1)
  console.log(`    VaultWithdraw : ${wd.result}`)

  const before = await photo(c, V6.mptId, { buyer1: W.buyer1.classicAddress, seller1: W.seller1.classicAddress })
  const r = await sendRaw(c, b)
  await sleep(3000)
  const d = diffPhoto(before, await photo(c, V6.mptId, { buyer1: W.buyer1.classicAddress, seller1: W.seller1.classicAddress }))
  note('H63', 'retrait du vendeur entre signature et soumission',
    `withdraw ${wd.result} · batch ${r.engine}${r.validated ? '→' + r.validated : ''} · Δparts buyer=${d.buyer1.shares} · Δxrp buyer=${d.buyer1.xrp} (fee enveloppe)`,
    d.buyer1.shares === 0n && d.buyer1.xrp < 0n
      ? '🔴 tesSUCCESS + rien livré + fee acheteur perdu — l\'acheteur-enveloppe paie pour un échec invisible'
      : d.buyer1.shares === 0n ? 'échec propre' : 'le swap est passé avant le retrait')
}

recap(R, 'CAMPAGNE E — PRIX + H63')
await c.disconnect()
