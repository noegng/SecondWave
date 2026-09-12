/**
 * probes-marche/06b-sequences-internes.mjs — suivi de B17.
 * Un Batch avec une jambe à séquence erronée valide tesSUCCESS : mais la jambe
 * s'applique-t-elle ? Ici on mesure les soldes, la seule preuve.
 */
import {
  connect, sequence, sleep, loadState, walletsOf, recap, sendRaw,
  batchEnvelope, signEnvelope, signMultiBatch, photo, diffPhoto,
} from './_lib.mjs'

const S = loadState('marche')
const W = walletsOf(S)
const c = await connect()
const V1 = S.vaults.V1
const ADDR = { seller: W.seller1.classicAddress, buyer: W.buyer1.classicAddress }
const R = []
const note = (cas, question, reponse, verdict) => { R.push({ cas, question, reponse, verdict }); console.log(`  [${cas}] ${reponse}\n        → ${verdict}`) }

async function runCase(cas, label, sellerLegSeqOf, buyerLegSeqOf) {
  const before = await photo(c, V1.mptId, ADDR)
  const sSeq = await sequence(c, ADDR.seller)
  const bSeq = await sequence(c, ADDR.buyer)
  const legs = [
    { TransactionType: 'Payment', Account: ADDR.seller, Destination: ADDR.buyer,
      Amount: { mpt_issuance_id: V1.mptId, value: '77000' }, Sequence: sellerLegSeqOf(sSeq) },
    { TransactionType: 'Payment', Account: ADDR.buyer, Destination: ADDR.seller,
      Amount: '66000', Sequence: buyerLegSeqOf(bSeq) },
  ]
  const b = await batchEnvelope(c, ADDR.seller, legs, { seq: sSeq })
  signMultiBatch(W.buyer1, b); signEnvelope(b, W.seller1)
  const r = await sendRaw(c, b)
  await sleep(3000)
  const d = diffPhoto(before, await photo(c, V1.mptId, ADDR))
  const applied = d.buyer.shares === 77_000n
  note(cas, label,
    `${r.engine}${r.validated ? '→' + r.validated : ''} · meta ${r.meta?.AffectedNodes?.length} nœud(s) · parts livrées=${d.buyer.shares} · prix payé=${-d.buyer.xrp} drops`,
    applied ? '⚠️ la jambe s\'applique MALGRÉ la séquence erronée' : 'la jambe échoue silencieusement — rollback')
  return { applied, r }
}

console.log('\n══ B17a\' · Jambe vendeur avec un TROU de séquence (envelope+5) — les soldes ══')
await runCase('B17a', 'trou de séquence côté vendeur', s => s + 5, b => b)

console.log('\n══ B17b\' · Jambe vendeur qui RÉUTILISE la séquence de l\'enveloppe — les soldes ══')
await runCase('B17b', 'jambe = séquence de l\'enveloppe', s => s, b => b)

console.log('\n══ B17c · Jambe avec Sequence: 0 (convention ticket/batch ?) ══')
await runCase('B17c', 'jambe à Sequence 0', () => 0, b => b)

console.log('\n══ B17d · Témoin : séquences correctes ══')
await runCase('B17d', 'séquences correctes (témoin)', s => s + 1, b => b)

recap(R, 'B17 — SÉQUENCES INTERNES, avec les soldes')
await c.disconnect()
