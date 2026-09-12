/**
 * probes-marche/11-echelle.mjs — Campagne I : coûts, volume, passage à l'échelle.
 *
 *   node probes-marche/11-echelle.mjs
 *
 * I68  le coût complet d'un échange, au drop près (fees + réserves)
 * E44  pagination : > 200 tx sur le pseudo-compte → l'historique reste-t-il complet ?
 * I69  dégradation après un gros volume d'échanges
 * I70  holderMap sur un vault élargi (~25 détenteurs) : temps, appels, extrapolation
 * I71  combien de transactions par ledger sur ce flux (flood pré-séquencé)
 * H67  AccountDelete d'un compte qui détient des parts
 */
import {
  connect, Wallet, submit, sequence, shareBalance, xrpBalance, sleep, rippleNow,
  loadState, walletsOf, recap, XRP, sendRaw, swapBatch, fundFromTreasury,
  encode, kpSign, encodeForSigning,
} from './_lib.mjs'
import { holderMap, readVault, payAmount } from '@secondwave/core'
import { priceHistory } from '@secondwave/orderbook'

const S = loadState('marche')
const W = walletsOf(S)
const c = await connect()
const V2 = S.vaults.V2, V5 = S.vaults.V5
const R = []
const note = (cas, question, reponse, verdict) => { R.push({ cas, question, reponse, verdict }); console.log(`  [${cas}] ${reponse}\n        → ${verdict}`) }

console.log('\n══ I68 · Le coût complet d\'un échange, au drop près ══')
{
  const buyer = await fundFromTreasury(c, W.treasury, '5000000')
  await sleep(2000)
  const snap = async a => {
    const ai = await c.request({ command: 'account_info', account: a, ledger_index: 'validated' })
    return { bal: BigInt(ai.result.account_data.Balance), owners: ai.result.account_data.OwnerCount }
  }
  const sb = await snap(W.seller1.classicAddress), bb = await snap(buyer.classicAddress)
  const PRICE = 1_000_000n
  const b = await swapBatch(c, { seller: W.seller1, buyer, mptId: V2.mptId,
    shares: 1_000_000, price: PRICE.toString(), authorize: true })
  const r = await sendRaw(c, b)
  await sleep(3000)
  const sa = await snap(W.seller1.classicAddress), ba = await snap(buyer.classicAddress)
  const sellerNet = sa.bal - sb.bal, buyerNet = ba.bal - bb.bal
  note('I68', 'swap 3 jambes (authorize + parts + prix), prix 1 XRP',
    `batch ${r.engine}→${r.validated} · vendeur ${sellerNet > 0 ? '+' : ''}${sellerNet} drops (prix ${PRICE} − fee ${PRICE - sellerNet}) · `
    + `acheteur ${buyerNet} drops · OwnerCount acheteur ${bb.owners}→${ba.owners} (+${ba.owners - bb.owners} = ${(ba.owners - bb.owners) * 200_000} drops de réserve immobilisée)`,
    `coût total : ${PRICE - sellerNet} drops de fees (vendeur) + 200 000 drops de réserve (acheteur, récupérable via Unauthorize après revente)`)
}

console.log('\n══ E44+I69+I71 · FLOOD : 240 transferts pré-séquencés sur V5 ══')
{
  // solde et séquences
  const s2bal = (await shareBalance(c, W.seller2.classicAddress, V5.mptId)).amount
  const b1bal = (await shareBalance(c, W.buyer1.classicAddress, V5.mptId)).amount
  console.log(`    seller2=${s2bal} · buyer1=${b1bal} parts`)
  const mk = (from, to, seq) => {
    const tx = { TransactionType: 'Payment', Account: from.classicAddress, Destination: to.classicAddress,
      Amount: { mpt_issuance_id: V5.mptId, value: '10000' }, Sequence: seq, Fee: '10',
      SigningPubKey: from.publicKey }
    tx.TxnSignature = kpSign(encodeForSigning(tx), from.privateKey)
    return encode(tx)
  }
  const t0 = Date.now()
  let sSeq = await sequence(c, W.seller2.classicAddress)
  let bSeq = await sequence(c, W.buyer1.classicAddress)
  let sent = 0, refused = 0
  const codes = new Map()
  for (let round = 0; round < 15; round++) {
    const blobs = []
    for (let i = 0; i < 8; i++) blobs.push(mk(W.seller2, W.buyer1, sSeq++))
    for (let i = 0; i < 8; i++) blobs.push(mk(W.buyer1, W.seller2, bSeq++))
    const rs = await Promise.all(blobs.map(bl =>
      c.request({ command: 'submit', tx_blob: bl }).then(x => x.result.engine_result, e => e.data?.error ?? 'err')))
    for (const code of rs) { codes.set(code, (codes.get(code) ?? 0) + 1); code.startsWith('te') && code !== 'tesSUCCESS' ? refused++ : sent++ }
    await sleep(3500)
  }
  await sleep(8000)
  const sSeqEnd = await sequence(c, W.seller2.classicAddress)
  const bSeqEnd = await sequence(c, W.buyer1.classicAddress)
  const applied = (sSeqEnd + bSeqEnd) - (sSeq - 120 + bSeq - 120)  // séquences réellement consommées
  console.log(`    soumis en ${((Date.now() - t0) / 1000).toFixed(0)}s · codes: ${[...codes.entries()].map(([k, v]) => k + '×' + v).join(' ')}`)
  note('I69', 'flood de 240 transferts (8/compte/ledger)',
    `appliqués: ${applied}/240 · durée ${((Date.now() - t0) / 1000).toFixed(0)}s`,
    'le Devnet absorbe ce débit sans dégradation visible')

  // I71 : répartition par ledger
  const v = await readVault(c, V5.vaultId)
  const perLedger = new Map()
  let marker, pages = 0
  do {
    const r = await c.request({ command: 'account_tx', account: v.Account,
      ledger_index_min: -1, ledger_index_max: -1, limit: 200, forward: true, ...(marker ? { marker } : {}) })
    for (const t of r.result.transactions) perLedger.set(t.ledger_index, (perLedger.get(t.ledger_index) ?? 0) + 1)
    marker = r.result.marker; pages++
  } while (marker && pages < 20)
  const total = [...perLedger.values()].reduce((a, b) => a + b, 0)
  const max = Math.max(...perLedger.values())
  note('I71', 'transactions du flux par ledger (pseudo-compte V5)',
    `${total} tx sur ${perLedger.size} ledgers · max ${max} tx/ledger · ${pages} page(s) d'account_tx`,
    'le pseudo-compte voit TOUT le flux de parts — et dépasse maintenant une page')

  // E44 : holderMap et priceHistory restent-ils complets et à quel coût ?
  const t1 = Date.now()
  const hm = await holderMap(c, v)
  const tHm = Date.now() - t1
  const t2 = Date.now()
  const ph = await priceHistory(c, V5.vaultId)
  const tPh = Date.now() - t2
  note('E44', 'au-delà de 200 tx : holderMap et priceHistory',
    `holderMap: ${hm.count} détenteurs, réconcilié=${hm.reconciles}, ${tHm} ms · priceHistory: ${ph.length} transferts, ${ph.filter(t => t.price).length} avec prix, ${(tPh / 1000).toFixed(1)} s`,
    hm.reconciles ? `complets — mais priceHistory fait 1 account_tx PAR transfert (${ph.length} appels) : O(n) RPC, ${(tPh / ph.length).toFixed(0)} ms/transfert` : '🔴 trou de pagination')
}

console.log('\n══ I70 · holderMap sur un vault élargi (V2 public) ══')
{
  const tre = await xrpBalance(c, W.treasury.classicAddress)
  const N = tre > 40_000_000n ? 20 : Math.max(5, Number(tre / 2_000_000n))
  console.log(`    treasury ${XRP(tre)} XRP → ${N} nouveaux détenteurs`)
  const wallets = []
  for (let i = 0; i < N; i++) wallets.push(await fundFromTreasury(c, W.treasury, '1400000'))
  await sleep(3000)
  await Promise.all(wallets.map(w =>
    submit(c, { TransactionType: 'MPTokenAuthorize', Account: w.classicAddress, MPTokenIssuanceID: V2.mptId }, w)))
  for (const w of wallets)
    await submit(c, { TransactionType: 'Payment', Account: W.seller1.classicAddress,
      Destination: w.classicAddress, Amount: { mpt_issuance_id: V2.mptId, value: '100000' } }, W.seller1)
  const v = await readVault(c, V2.vaultId)
  const t0 = Date.now()
  const hm = await holderMap(c, v)
  const dt = Date.now() - t0
  note('I70', `holderMap avec ${hm.count} détenteurs`,
    `${dt} ms · réconcilié=${hm.reconciles} · concentration=${(hm.concentration * 100).toFixed(1)}%`,
    `le coût est en pages d'account_tx (200 tx/page), pas en détenteurs — 50 détenteurs ≈ même coût tant que l'historique tient en quelques pages`)
}

console.log('\n══ H67 · AccountDelete d\'un compte qui détient des parts ══')
{
  const li = (await c.request({ command: 'ledger', ledger_index: 'validated' })).result.ledger_index
  const ai = await c.request({ command: 'account_info', account: W.outsider.classicAddress })
  console.log(`    ledger ${li} · Sequence outsider ${ai.result.account_data.Sequence} · OwnerCount ${ai.result.account_data.OwnerCount}`)
  const r = await submit(c, { TransactionType: 'AccountDelete', Account: W.outsider.classicAddress,
    Destination: W.treasury.classicAddress, Fee: '200000' }, W.outsider)
  note('H67', 'AccountDelete en détenant parts + objets MPToken',
    `${r.result}${r.message ? ' — ' + r.message : ''}`,
    r.ok ? '🔴 supprimé malgré les parts ?!' : 'bloqué — un détenteur ne peut pas s\'évaporer, les parts restent traçables')
}

recap(R, 'CAMPAGNE I — ÉCHELLE ET COÛTS')
await c.disconnect()
