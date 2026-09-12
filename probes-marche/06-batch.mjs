/**
 * probes-marche/06-batch.mjs — Campagne B : l'atomicité du Batch, cassée de toutes les façons.
 *
 *   node probes-marche/06-batch.mjs
 *
 * Cas : B14–B24, B26 + H62 (rejeu), H64 (compte vidé), H66 (prix vers soi-même).
 * Les cas 13, 21, 22, 25, 65 sont déjà mesurés (scripts 01–03) — non refaits.
 * Requiert state-marche.json. Vault V1 (privé, transférable).
 */
import {
  connect, submit, sequence, shareBalance, xrpBalance, sleep, rippleNow,
  loadState, walletsOf, recap, XRP, sendRaw, swapBatch, batchEnvelope, signEnvelope,
  signMultiBatch, BatchFlags, photo, diffPhoto,
} from './_lib.mjs'

const S = loadState('marche')
const W = walletsOf(S)
const c = await connect()
const V1 = S.vaults.V1
const R = []
const note = (cas, question, reponse, verdict) => { R.push({ cas, question, reponse, verdict }); console.log(`  [${cas}] ${reponse}\n        → ${verdict}`) }
const res = r => `${r.engine}${r.validated ? '→' + r.validated : ''}${r.message && !r.validated ? ' — ' + r.message : ''}`

const ADDR = { seller: W.seller1.classicAddress, buyer: W.buyer1.classicAddress }

console.log('\n══ B14+B23 · La jambe des PARTS échoue (vendeur à découvert) — sort du Batch + coût ══')
{
  const before = await photo(c, V1.mptId, ADDR)
  const b = await swapBatch(c, { seller: W.seller1, buyer: W.buyer1, mptId: V1.mptId,
    shares: 999_000_000, price: 1_000_000 })          // seller1 n'a pas 999M parts
  const r = await sendRaw(c, b)
  await sleep(3000)
  const d = diffPhoto(before, await photo(c, V1.mptId, ADDR))
  note('B14', 'jambe 2 (parts) en échec, jambe 3 (prix) payable',
    `${res(r)} · meta ${r.meta?.AffectedNodes?.length} nœud(s) · Δparts buyer=${d.buyer.shares} · Δxrp buyer=${d.buyer.xrp}`,
    d.buyer.shares === 0n && d.buyer.xrp === 0n ? 'rollback complet — l\'acheteur ne paie pas pour rien' : '🔴 le prix part sans les parts')
  note('B23', 'coût d\'un échec silencieux', `le vendeur (enveloppe) a perdu ${-d.seller.xrp} drops`,
    'le Fee du Batch est consommé même quand rien ne s\'applique')
}

console.log('\n══ B15 · Jambe 1 : MPTokenAuthorize sur une issuance INEXISTANTE ══')
{
  const fake = V1.mptId.slice(0, -4) + '0000'
  const before = await photo(c, V1.mptId, ADDR)
  const sSeq = await sequence(c, ADDR.seller)
  let bSeq = await sequence(c, ADDR.buyer)
  const legs = [
    { TransactionType: 'MPTokenAuthorize', Account: ADDR.buyer, MPTokenIssuanceID: fake, Sequence: bSeq++ },
    { TransactionType: 'Payment', Account: ADDR.seller, Destination: ADDR.buyer,
      Amount: { mpt_issuance_id: V1.mptId, value: '100000' }, Sequence: sSeq + 1 },
    { TransactionType: 'Payment', Account: ADDR.buyer, Destination: ADDR.seller, Amount: '100000', Sequence: bSeq++ },
  ]
  const b = await batchEnvelope(c, ADDR.seller, legs, { seq: sSeq })
  signMultiBatch(W.buyer1, b); signEnvelope(b, W.seller1)
  const r = await sendRaw(c, b)
  await sleep(3000)
  const d = diffPhoto(before, await photo(c, V1.mptId, ADDR))
  note('B15', 'authorize sur MPT inexistant en jambe 1',
    `${res(r)} · Δparts buyer=${d.buyer.shares} · Δxrp buyer=${d.buyer.xrp}`,
    d.buyer.shares === 0n ? 'rollback complet' : '🔴')
}

console.log('\n══ B16 · Jambes dans le MAUVAIS ORDRE : transfert avant autorisation (acheteur vierge) ══')
{
  // buyer2 n'a jamais touché V1 : pas d'objet MPToken.
  const pre = await shareBalance(c, W.buyer2.classicAddress, V1.mptId)
  const sSeq = await sequence(c, ADDR.seller)
  let bSeq = await sequence(c, W.buyer2.classicAddress)
  const legs = [
    { TransactionType: 'Payment', Account: ADDR.seller, Destination: W.buyer2.classicAddress,
      Amount: { mpt_issuance_id: V1.mptId, value: '100000' }, Sequence: sSeq + 1 },
    { TransactionType: 'MPTokenAuthorize', Account: W.buyer2.classicAddress, MPTokenIssuanceID: V1.mptId, Sequence: bSeq++ },
    { TransactionType: 'Payment', Account: W.buyer2.classicAddress, Destination: ADDR.seller, Amount: '100000', Sequence: bSeq++ },
  ]
  const b = await batchEnvelope(c, ADDR.seller, legs, { seq: sSeq })
  signMultiBatch(W.buyer2, b); signEnvelope(b, W.seller1)
  const r = await sendRaw(c, b)
  await sleep(3000)
  const post = await shareBalance(c, W.buyer2.classicAddress, V1.mptId)
  note('B16', 'transfert (jambe 1) avant autorisation (jambe 2)',
    `avant: holds=${pre.holds} · ${res(r)} · après: holds=${post.holds} amount=${post.amount}`,
    post.amount === 0n ? 'l\'ordre des jambes compte — le builder DOIT mettre l\'authorize en premier' : 'l\'ordre est indifférent')
}

console.log('\n══ B17 · Séquences erronées dans une jambe ══')
{
  // a) trou : la jambe du vendeur saute une séquence
  const sSeq = await sequence(c, ADDR.seller)
  let bSeq = await sequence(c, ADDR.buyer)
  const mk = (sellerLegSeq) => ([
    { TransactionType: 'Payment', Account: ADDR.seller, Destination: ADDR.buyer,
      Amount: { mpt_issuance_id: V1.mptId, value: '100000' }, Sequence: sellerLegSeq },
    { TransactionType: 'Payment', Account: ADDR.buyer, Destination: ADDR.seller, Amount: '50000', Sequence: bSeq },
  ])
  let b = await batchEnvelope(c, ADDR.seller, mk(sSeq + 5), { seq: sSeq })
  signMultiBatch(W.buyer1, b); signEnvelope(b, W.seller1)
  const r1 = await sendRaw(c, b)
  note('B17a', 'jambe avec un TROU de séquence (envelope+5)', res(r1), 'comportement des séquences internes')

  // b) séquence déjà consommée : la jambe reprend la séquence de l'enveloppe
  const sSeq2 = await sequence(c, ADDR.seller)
  bSeq = await sequence(c, ADDR.buyer)
  b = await batchEnvelope(c, ADDR.seller, mk(sSeq2), { seq: sSeq2 })
  signMultiBatch(W.buyer1, b); signEnvelope(b, W.seller1)
  const r2 = await sendRaw(c, b)
  note('B17b', 'jambe qui RÉUTILISE la séquence de l\'enveloppe', res(r2), 'collision détectée ou non')
}

console.log('\n══ B18 · Une jambe dont le compte n\'a PAS signé le Batch ══')
{
  const b = await swapBatch(c, { seller: W.seller1, buyer: W.buyer1, mptId: V1.mptId,
    shares: 100_000, price: 50_000 })
  delete b.BatchSigners                       // on retire la signature de l'acheteur
  signEnvelope(b, W.seller1)
  const r = await sendRaw(c, b)
  note('B18', 'Batch sans la signature de l\'acheteur (jambes acheteur présentes)', res(r),
    'le protocole doit exiger un BatchSigner par compte interne ≠ enveloppe')
}

console.log('\n══ B19+B20 · Nombre de jambes : 1, 2, 3, 8, 9, 12 — où est la limite ? ══')
{
  for (const n of [1, 2, 3, 8, 9, 12]) {
    const sSeq = await sequence(c, ADDR.seller)
    let bSeq = await sequence(c, ADDR.buyer)
    let sNext = sSeq + 1
    const legs = []
    for (let i = 0; i < n; i++) {
      if (i % 2 === 0) legs.push({ TransactionType: 'Payment', Account: ADDR.seller,
        Destination: ADDR.buyer, Amount: '1000', Sequence: sNext++ })
      else legs.push({ TransactionType: 'Payment', Account: ADDR.buyer,
        Destination: ADDR.seller, Amount: '1000', Sequence: bSeq++ })
    }
    const b = await batchEnvelope(c, ADDR.seller, legs, { seq: sSeq })
    if (n > 1) signMultiBatch(W.buyer1, b)
    signEnvelope(b, W.seller1)
    const r = await sendRaw(c, b)
    console.log(`    ${String(n).padStart(2)} jambes → ${res(r)}`)
    R.push({ cas: 'B20', question: `Batch à ${n} jambes`, reponse: res(r), verdict: '' })
    if (r.validated === 'tesSUCCESS') await sleep(1000)
  }
}

console.log('\n══ B24 · LastLedgerSequence trop court ══')
{
  const b = await swapBatch(c, { seller: W.seller1, buyer: W.buyer1, mptId: V1.mptId,
    shares: 100_000, price: 50_000 })
  const li = (await c.request({ command: 'ledger', ledger_index: 'validated' })).result.ledger_index
  b.LastLedgerSequence = li          // déjà dépassé au moment de la soumission
  signMultiBatch(W.buyer1, { ...b })  // resigner après modification
  delete b.BatchSigners
  signMultiBatch(W.buyer1, b)
  signEnvelope(b, W.seller1)
  const r = await sendRaw(c, b)
  note('B24', 'LastLedgerSequence déjà dépassé', res(r), 'le code que le vendeur verra si le réseau est lent')
}

console.log('\n══ B26 · LoanSet dans un Batch (kDisabledTxTypes) ══')
{
  const sSeq = await sequence(c, ADDR.seller)
  const legs = [
    { TransactionType: 'LoanSet', Account: ADDR.seller, LoanBrokerID: V1.vaultId,
      PrincipalRequested: '1000000', PaymentInterval: 60, PaymentTotal: 2,
      GracePeriod: 60, InterestRate: 1000, Sequence: sSeq + 1 },
    { TransactionType: 'AccountSet', Account: ADDR.seller, Sequence: sSeq + 2 },
  ]
  let r
  try {
    const b = await batchEnvelope(c, ADDR.seller, legs, { seq: sSeq })
    signEnvelope(b, W.seller1)
    r = await sendRaw(c, b)
  } catch (e) { r = { engine: 'SDK/encode', message: e.message } }
  note('B26', 'LoanSet en jambe interne', res(r), 'les 15 transactions XLS-65/66 sont exclues du Batch')
}

console.log('\n══ H62 · REJEU d\'un Batch déjà validé ══')
{
  const b = await swapBatch(c, { seller: W.seller1, buyer: W.buyer1, mptId: V1.mptId,
    shares: 50_000, price: 40_000 })
  const r1 = await sendRaw(c, b)          // premier passage : doit s'appliquer
  const r2 = await sendRaw(c, b)          // rejeu du même blob
  note('H62', 'resoumission du même Batch signé', `1er: ${res(r1)} · rejeu: ${res(r2)}`,
    'la séquence de l\'enveloppe rend le rejeu inoffensif')
}

console.log('\n══ H64 · L\'acheteur VIDE SON COMPTE entre signature et soumission ══')
{
  const before = await photo(c, V1.mptId, { seller: ADDR.seller, buyer2: W.buyer2.classicAddress })
  const bx = await xrpBalance(c, W.buyer2.classicAddress)
  const price = bx - 3_000_000n                          // presque tout son solde
  const b = await swapBatch(c, { seller: W.seller1, buyer: W.buyer2, mptId: V1.mptId,
    shares: 500_000, price: String(price), authorize: true })
  // l'acheteur signe… puis vide son compte
  const drain = await submit(c, { TransactionType: 'Payment', Account: W.buyer2.classicAddress,
    Destination: W.treasury.classicAddress, Amount: String(bx - 4_000_000n) }, W.buyer2)
  const r = await sendRaw(c, b)
  await sleep(3000)
  const d = diffPhoto(before, await photo(c, V1.mptId, { seller: ADDR.seller, buyer2: W.buyer2.classicAddress }))
  note('H64', 'compte acheteur vidé après signature',
    `drain ${drain.result} · batch ${res(r)} · Δparts buyer2=${d.buyer2.shares} · Δxrp seller=${d.seller.xrp}`,
    d.buyer2.shares === 0n ? 'rollback — le vendeur ne livre pas à un insolvable (mais paie le Fee)' : '🔴')
}

console.log('\n══ H66 · Le vendeur s\'envoie le prix à LUI-MÊME ══')
{
  const sSeq = await sequence(c, ADDR.seller)
  const legs = [
    { TransactionType: 'Payment', Account: ADDR.seller, Destination: ADDR.buyer,
      Amount: { mpt_issuance_id: V1.mptId, value: '100000' }, Sequence: sSeq + 1 },
    { TransactionType: 'Payment', Account: ADDR.seller, Destination: ADDR.seller, Amount: '100000', Sequence: sSeq + 2 },
  ]
  let r
  try {
    const b = await batchEnvelope(c, ADDR.seller, legs, { seq: sSeq })
    signEnvelope(b, W.seller1)
    r = await sendRaw(c, b)
  } catch (e) { r = { engine: 'SDK/encode', message: e.message } }
  note('H66', 'jambe de prix Account==Destination', res(r),
    'un swap "gratuit" déguisé doit être détecté par le carnet, pas par le protocole')
}

// Bilan des séquences : un Batch annulé consomme-t-il les séquences internes ?
console.log('\n══ Bonus · Un Batch entièrement annulé consomme-t-il les séquences INTERNES ? ══')
{
  const s0 = await sequence(c, ADDR.seller)
  const b0 = await sequence(c, ADDR.buyer)
  const b = await swapBatch(c, { seller: W.seller1, buyer: W.buyer1, mptId: V1.mptId,
    shares: 999_000_000, price: 1_000 })              // jambe parts impossible
  const r = await sendRaw(c, b)
  await sleep(2000)
  const s1 = await sequence(c, ADDR.seller)
  const b1 = await sequence(c, ADDR.buyer)
  note('B-seq', 'séquences après rollback complet',
    `${res(r)} · vendeur ${s0}→${s1} (+${s1 - s0}) · acheteur ${b0}→${b1} (+${b1 - b0})`,
    'ce que le builder doit resynchroniser après un échec silencieux')
}

recap(R, 'CAMPAGNE B — BATCH')
await c.disconnect()
