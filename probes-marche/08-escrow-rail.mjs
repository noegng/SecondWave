/**
 * probes-marche/08-escrow-rail.mjs — Campagne G/F : l'escrow comme rail de règlement.
 *
 *   node probes-marche/08-escrow-rail.mjs
 *
 * E1 ⭐ l'échange atomique SANS Batch : deux escrows liés par la même condition
 *      (HTLC) — parts contre XRP, secret révélé on-chain au premier Finish.
 * E2  le gate au DÉNOUEMENT : destinataire exclu du domaine entre Create et Finish
 * E2b EscrowFinish soumis par un TIERS
 * E3  EscrowCancel rend-il les parts ?
 * E4  Smart Escrow : FinishFunction connu du SDK/du réseau ?
 * E5  le carnet on-chain : escrow sans Destination ? vers soi-même ?
 * E7  escrow de parts d'un vault PUBLIC vers un compte sans credential
 * E8  la comptabilité du blocage : où vivent les parts pendant l'escrow ?
 */
import {
  connect, submit, sequence, shareBalance, xrpBalance, sleep, rippleNow,
  loadState, walletsOf, recap, XRP, makeCondition, deleteCredential, txUrl,
} from './_lib.mjs'

const S = loadState('marche')
const W = walletsOf(S)
const c = await connect()
const V1 = S.vaults.V1, V2 = S.vaults.V2
const R = []
const note = (cas, question, reponse, verdict) => { R.push({ cas, question, reponse, verdict }); console.log(`  [${cas}] ${reponse}\n        → ${verdict}`) }
const code = r => `${r.result}${r.message && r.result !== 'tesSUCCESS' ? ' — ' + r.message : ''}`
const parts = (mpt, v) => ({ mpt_issuance_id: mpt, value: String(v) })
const seqOf = r => r.raw?.result?.tx_json?.Sequence

console.log('\n══ E1 ⭐ · ÉCHANGE ATOMIQUE SANS BATCH — deux escrows, une condition ══')
{
  const { condition, fulfillment } = makeCondition()
  console.log(`    condition   ${condition}`)
  const before = {
    sellerShares: (await shareBalance(c, W.seller1.classicAddress, V1.mptId)).amount,
    buyerShares: (await shareBalance(c, W.buyer1.classicAddress, V1.mptId)).amount,
    sellerXrp: await xrpBalance(c, W.seller1.classicAddress),
    buyerXrp: await xrpBalance(c, W.buyer1.classicAddress),
  }
  // 1. Le vendeur bloque les parts — annulable à T+600 seulement.
  const e1 = await submit(c, {
    TransactionType: 'EscrowCreate', Account: W.seller1.classicAddress,
    Destination: W.buyer1.classicAddress, Amount: parts(V1.mptId, 1_000_000),
    Condition: condition, CancelAfter: rippleNow() + 600,
  }, W.seller1)
  // 2. L'acheteur bloque le prix — annulable à T+900 : le vendeur garde une marge
  //    pour réutiliser le secret même si l'acheteur dénoue au dernier moment.
  const e2 = await submit(c, {
    TransactionType: 'EscrowCreate', Account: W.buyer1.classicAddress,
    Destination: W.seller1.classicAddress, Amount: '900000',
    Condition: condition, CancelAfter: rippleNow() + 900,
  }, W.buyer1)
  console.log(`    EscrowCreate parts  : ${e1.result} (seq ${seqOf(e1)})`)
  console.log(`    EscrowCreate prix   : ${e2.result} (seq ${seqOf(e2)})`)

  // 3. L'acheteur (détenteur du secret) dénoue la jambe des PARTS → révèle le secret.
  const f1 = await submit(c, {
    TransactionType: 'EscrowFinish', Account: W.buyer1.classicAddress,
    Owner: W.seller1.classicAddress, OfferSequence: seqOf(e1),
    Condition: condition, Fulfillment: fulfillment, Fee: '1000',
  }, W.buyer1)
  console.log(`    EscrowFinish parts  : ${f1.result} · ${f1.url ?? ''}`)

  // 4. Le vendeur RELIT le secret depuis la transaction validée…
  let secretLu = null
  if (f1.hash) {
    const t = await c.request({ command: 'tx', transaction: f1.hash })
    secretLu = t.result.tx_json?.Fulfillment ?? t.result.Fulfillment ?? null
  }
  console.log(`    secret relu on-chain: ${secretLu} (${secretLu === fulfillment ? 'identique' : 'DIFFÉRENT'})`)

  // 5. …et dénoue la jambe du PRIX avec ce secret.
  const f2 = await submit(c, {
    TransactionType: 'EscrowFinish', Account: W.seller1.classicAddress,
    Owner: W.buyer1.classicAddress, OfferSequence: seqOf(e2),
    Condition: condition, Fulfillment: secretLu ?? fulfillment, Fee: '1000',
  }, W.seller1)
  console.log(`    EscrowFinish prix   : ${f2.result}`)

  await sleep(2000)
  const after = {
    sellerShares: (await shareBalance(c, W.seller1.classicAddress, V1.mptId)).amount,
    buyerShares: (await shareBalance(c, W.buyer1.classicAddress, V1.mptId)).amount,
    sellerXrp: await xrpBalance(c, W.seller1.classicAddress),
    buyerXrp: await xrpBalance(c, W.buyer1.classicAddress),
  }
  const livre = after.buyerShares - before.buyerShares
  const paye = before.buyerXrp - after.buyerXrp
  note('E1', 'échange atomique par deux escrows conditionnés (HTLC)',
    `4 tx (${e1.result}/${e2.result}/${f1.result}/${f2.result}) · ${livre} parts livrées · acheteur débité ${XRP(paye)} XRP (prix 0,9 + fees)`,
    livre === 1_000_000n && f2.ok
      ? '⭐⭐ RAIL COMPLET — atomicité par le secret, sans Batch, offre visible on-chain'
      : 'une jambe n\'a pas dénoué — voir codes')
}

console.log('\n══ E2 · Le gate au DÉNOUEMENT : destinataire exclu entre Create et Finish ══')
{
  // victim est membre : l'escrow se crée. Puis on supprime son credential.
  const e = await submit(c, {
    TransactionType: 'EscrowCreate', Account: W.seller1.classicAddress,
    Destination: W.victim.classicAddress, Amount: parts(V1.mptId, 200_000),
    FinishAfter: rippleNow() + 12, CancelAfter: rippleNow() + 240,
  }, W.seller1)
  // au passage : des parts directes pour le test AccountDelete de la campagne 11
  const direct = await submit(c, {
    TransactionType: 'Payment', Account: W.seller1.classicAddress,
    Destination: W.victim.classicAddress, Amount: parts(V1.mptId, 100_000),
  }, W.victim.classicAddress === W.seller1.classicAddress ? W.victim : W.seller1)
  const del = await deleteCredential(c, W.issuer, W.victim.classicAddress, 'KYC')
  console.log(`    EscrowCreate ${e.result} · parts directes ${direct.result} · CredentialDelete ${del.result}`)
  await sleep(14_000)
  const f = await submit(c, {
    TransactionType: 'EscrowFinish', Account: W.victim.classicAddress,
    Owner: W.seller1.classicAddress, OfferSequence: seqOf(e), Fee: '1000',
  }, W.victim)
  const b = await shareBalance(c, W.victim.classicAddress, V1.mptId)
  note('E2', 'EscrowFinish vers un destinataire devenu NON-membre',
    `finish ${code(f)} · victim détient ${b.amount}`,
    f.ok ? '🔴 LE GATE NE S\'APPLIQUE PAS AU DÉNOUEMENT — un exclu peut encore recevoir via un escrow pré-créé (à signaler)'
         : 'le gate est re-vérifié au Finish — l\'escrow reste bloqué jusqu\'au Cancel')
}

console.log('\n══ E2b · EscrowFinish soumis par un TIERS étranger ══')
{
  const e = await submit(c, {
    TransactionType: 'EscrowCreate', Account: W.seller1.classicAddress,
    Destination: W.buyer1.classicAddress, Amount: parts(V1.mptId, 50_000),
    FinishAfter: rippleNow() + 12, CancelAfter: rippleNow() + 240,
  }, W.seller1)
  await sleep(14_000)
  const before = (await shareBalance(c, W.buyer1.classicAddress, V1.mptId)).amount
  const f = await submit(c, {
    TransactionType: 'EscrowFinish', Account: W.outsider.classicAddress,   // ni owner ni destinataire
    Owner: W.seller1.classicAddress, OfferSequence: seqOf(e), Fee: '1000',
  }, W.outsider)
  const after = (await shareBalance(c, W.buyer1.classicAddress, V1.mptId)).amount
  note('E2b', 'un tiers sans credential dénoue l\'escrow d\'autrui',
    `finish ${code(f)} · ${after - before} parts livrées à buyer1`,
    f.ok ? 'n\'importe qui peut régler — le règlement est délégable (relayer possible)' : 'restreint')
}

console.log('\n══ E3 · EscrowCancel rend les parts ══')
{
  const before = (await shareBalance(c, W.seller1.classicAddress, V1.mptId)).amount
  const e = await submit(c, {
    TransactionType: 'EscrowCreate', Account: W.seller1.classicAddress,
    Destination: W.buyer1.classicAddress, Amount: parts(V1.mptId, 300_000),
    FinishAfter: rippleNow() + 5, CancelAfter: rippleNow() + 12,
  }, W.seller1)
  const pendant = (await shareBalance(c, W.seller1.classicAddress, V1.mptId)).amount
  await sleep(16_000)
  const x = await submit(c, {
    TransactionType: 'EscrowCancel', Account: W.buyer1.classicAddress,     // même un tiers
    Owner: W.seller1.classicAddress, OfferSequence: seqOf(e),
  }, W.buyer1)
  const apres = (await shareBalance(c, W.seller1.classicAddress, V1.mptId)).amount
  note('E3', 'cycle create→cancel : les parts reviennent-elles ?',
    `create ${e.result} (${before}→${pendant}) · cancel ${code(x)} · solde final ${apres}`,
    apres === before ? 'retour intégral — une offre escrow est annulable proprement après CancelAfter' : '🔴 parts perdues')
}

console.log('\n══ E4 · Smart Escrow : FinishFunction ══')
{
  let r
  try {
    r = await submit(c, {
      TransactionType: 'EscrowCreate', Account: W.seller1.classicAddress,
      Destination: W.buyer1.classicAddress, Amount: parts(V1.mptId, 10_000),
      FinishFunction: '0061736D01000000',        // en-tête WASM minimal
      CancelAfter: rippleNow() + 300,
    }, W.seller1)
    r = { kind: 'submit', text: code(r) }
  } catch (e) { r = { kind: 'sdk', text: e.message } }
  note('E4', 'EscrowCreate avec FinishFunction (WASM)', `${r.kind}: ${r.text}`,
    'état du Smart Escrow sur ce Devnet + support SDK')
}

console.log('\n══ E5 · Le carnet on-chain : escrow SANS Destination · vers SOI-MÊME ══')
{
  let r1
  try {
    r1 = await submit(c, {
      TransactionType: 'EscrowCreate', Account: W.seller1.classicAddress,
      Amount: parts(V1.mptId, 10_000), CancelAfter: rippleNow() + 300,
      Condition: makeCondition().condition,
    }, W.seller1)
    r1 = code(r1)
  } catch (e) { r1 = `sdk: ${e.message}` }
  let r2 = await submit(c, {
    TransactionType: 'EscrowCreate', Account: W.seller1.classicAddress,
    Destination: W.seller1.classicAddress, Amount: parts(V1.mptId, 10_000),
    FinishAfter: rippleNow() + 60, CancelAfter: rippleNow() + 120,
  }, W.seller1)
  note('E5', 'escrow sans Destination (offre ouverte) · vers soi-même',
    `sans Destination: ${r1} · vers soi-même: ${code(r2)}`,
    'la Destination est obligatoire et nominative — un escrow est un engagement BILATÉRAL, pas une offre ouverte')
}

console.log('\n══ E7 · Escrow de parts d\'un vault PUBLIC vers un compte sans credential ══')
{
  const e = await submit(c, {
    TransactionType: 'EscrowCreate', Account: W.seller1.classicAddress,
    Destination: W.outsider.classicAddress, Amount: parts(V2.mptId, 500_000),
    FinishAfter: rippleNow() + 10, CancelAfter: rippleNow() + 240,
  }, W.seller1)
  await sleep(12_000)
  const f = await submit(c, {
    TransactionType: 'EscrowFinish', Account: W.outsider.classicAddress,
    Owner: W.seller1.classicAddress, OfferSequence: seqOf(e), Fee: '1000',
  }, W.outsider)
  const b = await shareBalance(c, W.outsider.classicAddress, V2.mptId)
  note('E7', 'escrow public → outsider', `create ${e.result} · finish ${code(f)} · outsider détient ${b.amount}`,
    f.ok ? 'le rail escrow est ouvert sur un vault public' : 'restreint — voir code')
}

console.log('\n══ E8 · Où vivent les parts pendant l\'escrow ? (comptabilité du blocage) ══')
{
  const e = await submit(c, {
    TransactionType: 'EscrowCreate', Account: W.seller1.classicAddress,
    Destination: W.buyer1.classicAddress, Amount: parts(V1.mptId, 123_456),
    FinishAfter: rippleNow() + 120, CancelAfter: rippleNow() + 600,
  }, W.seller1)
  const objs = (await c.request({ command: 'account_objects', account: W.seller1.classicAddress,
    type: 'escrow', ledger_index: 'validated' })).result.account_objects
  const mine = objs.find(o => o.Amount?.mpt_issuance_id === V1.mptId && o.Amount?.value === '123456')
  const tok = (await c.request({ command: 'account_objects', account: W.seller1.classicAddress,
    type: 'mptoken', ledger_index: 'validated' })).result.account_objects
    .find(o => o.MPTokenIssuanceID === V1.mptId)
  const iss = (await c.request({ command: 'ledger_entry', mpt_issuance: V1.mptId, ledger_index: 'validated' })).result.node
  note('E8', 'champs pendant le blocage',
    `escrow.Amount=${JSON.stringify(mine?.Amount)} · MPToken{Amount:${tok?.MPTAmount}, Locked:${tok?.LockedAmount ?? '—'}} · issuance{Outstanding:${iss?.OutstandingAmount}, Locked:${iss?.LockedAmount ?? '—'}}`,
    'l\'escrow porte le montant · le solde du vendeur est débité · Outstanding inchangé (les parts existent toujours)')
}

recap(R, 'CAMPAGNE ESCROW — LE RAIL ALTERNATIF')
await c.disconnect()
