/**
 * probes-marche/07-preflight.mjs — Campagne C : le preflight du SettlementEngine.
 *
 *   node probes-marche/07-preflight.mjs
 *
 * C27  chaque contrôle déclenché une fois — pas de faux positif ?
 * C28  ⭐ les faux négatifs : preflight OK mais swap qui échoue quand même
 *       a) vendeur exclu du domaine (le preflight ne vérifie QUE l'acheteur)
 *       b) parts déjà engagées en escrow au moment de l'offre
 * C29  `simulate` : sur quoi marche-t-il ? Sur un Batch entier ?
 * C30/31 la réserve réelle de l'acheteur, au drop près
 * C32  course : les parts bougent entre preflight et soumission
 */
import {
  connect, submit, sequence, shareBalance, xrpBalance, sleep, rippleNow,
  loadState, walletsOf, recap, XRP, sendRaw, swapBatch, photo, diffPhoto,
  fundFromTreasury, issueCredentialRaw, acceptCredential, encode,
} from './_lib.mjs'
import { SettlementEngine } from '@secondwave/settlement'

const S = loadState('marche')
const W = walletsOf(S)
const c = await connect()
const V1 = S.vaults.V1, V3 = S.vaults.V3
const engine = new SettlementEngine(c)
const R = []
const note = (cas, question, reponse, verdict) => { R.push({ cas, question, reponse, verdict }); console.log(`  [${cas}] ${reponse}\n        → ${verdict}`) }

const pf = args => engine.preflight(args)
const short = p => `ok=${p.ok}${p.blockers.length ? ' · ' + p.blockers.join(' | ') : ''}`

console.log('\n══ C27 · Chaque contrôle du preflight, déclenché une fois ══')
{
  const cases = [
    ['non-transférable', { vaultId: V3.vaultId, seller: W.seller1.classicAddress, buyer: W.buyer1.classicAddress, shares: 1000, price: 1000 }, 'parts transférables'],
    ['acheteur non-membre', { vaultId: V1.vaultId, seller: W.seller1.classicAddress, buyer: W.outsider.classicAddress, shares: 1000, price: 1000 }, 'acheteur éligible'],
    ['vendeur à découvert', { vaultId: V1.vaultId, seller: W.seller1.classicAddress, buyer: W.buyer1.classicAddress, shares: '999000000000', price: 1000 }, 'parts du vendeur'],
    ['acheteur sans trésorerie', { vaultId: V1.vaultId, seller: W.seller1.classicAddress, buyer: W.buyer1.classicAddress, shares: 1000, price: '999000000000' }, 'trésorerie acheteur'],
    ['cas nominal (témoin)', { vaultId: V1.vaultId, seller: W.seller1.classicAddress, buyer: W.buyer1.classicAddress, shares: 1000, price: 1000 }, null],
  ]
  for (const [label, args, expectedBlocker] of cases) {
    const p = await pf(args)
    const hit = expectedBlocker ? p.blockers.some(b => b.startsWith(expectedBlocker)) : p.ok
    console.log(`    ${label.padEnd(26)} ${short(p)}`)
    R.push({ cas: 'C27', question: label, reponse: short(p),
      verdict: hit ? 'contrôle déclenché correctement' : `⚠️ attendu « ${expectedBlocker} », obtenu autre chose` })
  }
}

console.log('\n══ C28a ⭐ · FAUX NÉGATIF : le vendeur exclu du domaine ══')
{
  // revoked détient 500 000 parts de V1 mais son credential a été supprimé (05).
  // buyer2 est membre SANS objet MPToken → le preflight simule l'authorize, pas le transfert.
  const p = await pf({ vaultId: V1.vaultId, seller: W.revoked.classicAddress,
    buyer: W.buyer2.classicAddress, shares: 100_000, price: 90_000 })
  console.log(`    preflight: ${short(p)}`)
  let outcome = '—'
  if (p.ok) {
    const before = await photo(c, V1.mptId, { revoked: W.revoked.classicAddress, buyer2: W.buyer2.classicAddress })
    const b = await swapBatch(c, { seller: W.revoked, buyer: W.buyer2, mptId: V1.mptId,
      shares: 100_000, price: 90_000, authorize: p.needsAuthorize })
    const r = await sendRaw(c, b)
    await sleep(3000)
    const d = diffPhoto(before, await photo(c, V1.mptId, { revoked: W.revoked.classicAddress, buyer2: W.buyer2.classicAddress }))
    outcome = `batch ${r.engine}→${r.validated} · parts livrées=${d.buyer2.shares}`
    note('C28a', 'preflight OK alors que le VENDEUR est exclu du domaine',
      `preflight ok=true · ${outcome}`,
      d.buyer2.shares === 0n ? '🔴 FAUX NÉGATIF TROUVÉ — le preflight ne vérifie jamais l\'éligibilité du vendeur' : 'le swap passe (pas de trou)')
  } else {
    note('C28a', 'le preflight attrape-t-il un vendeur exclu ?', short(p), 'pas de faux négatif ici')
  }
}

console.log('\n══ C28b · FAUX NÉGATIF : parts engagées en escrow après le preflight ══')
{
  // seller2 a 30M parts V1. Le preflight voit ce solde… puis un escrow en bloque l'essentiel.
  const sb = await shareBalance(c, W.seller2.classicAddress, V1.mptId)
  const p = await pf({ vaultId: V1.vaultId, seller: W.seller2.classicAddress,
    buyer: W.buyer1.classicAddress, shares: sb.amount.toString(), price: 1_000_000 })
  const esc = await submit(c, {
    TransactionType: 'EscrowCreate', Account: W.seller2.classicAddress,
    Destination: W.buyer1.classicAddress,
    Amount: { mpt_issuance_id: V1.mptId, value: (sb.amount - 1_000_000n).toString() },
    FinishAfter: rippleNow() + 3600, CancelAfter: rippleNow() + 7200,
  }, W.seller2)
  const after = await shareBalance(c, W.seller2.classicAddress, V1.mptId)
  const p2 = await pf({ vaultId: V1.vaultId, seller: W.seller2.classicAddress,
    buyer: W.buyer1.classicAddress, shares: sb.amount.toString(), price: 1_000_000 })
  note('C28b', 'un escrow créé entre le preflight et l\'exécution',
    `preflight avant: ok=${p.ok} · escrow ${esc.result} · solde ${sb.amount}→${after.amount} · preflight après: ok=${p2.ok}`,
    !p2.ok ? 'le solde MPToken étant débité dès EscrowCreate, un preflight RÉ-EXÉCUTÉ voit le trou — mais une offre au carnet non revalidée est morte'
           : '🔴 le preflight ne voit pas les parts en escrow')
}

console.log('\n══ C29 · `simulate` : Payment de parts, MPTokenAuthorize, Batch entier ══')
{
  const sims = []
  const trySim = async (label, tx_json) => {
    try {
      const r = await c.request({ command: 'simulate', tx_json })
      sims.push([label, r.result.engine_result ?? JSON.stringify(r.result).slice(0, 80)])
    } catch (e) { sims.push([label, `erreur: ${e.data?.error ?? e.message}`]) }
  }
  await trySim('Payment de parts', { TransactionType: 'Payment', Account: W.seller1.classicAddress,
    Destination: W.buyer1.classicAddress, Amount: { mpt_issuance_id: V1.mptId, value: '1000' } })
  await trySim('MPTokenAuthorize', { TransactionType: 'MPTokenAuthorize', Account: W.buyer2.classicAddress,
    MPTokenIssuanceID: V1.mptId })
  const b = await swapBatch(c, { seller: W.seller1, buyer: W.buyer1, mptId: V1.mptId, shares: 1000, price: 900 })
  delete b.TxnSignature; delete b.SigningPubKey    // simulate exige du non-signé
  const noSig = JSON.parse(JSON.stringify(b))
  noSig.BatchSigners = undefined
  await trySim('Batch complet (signé jambes)', b)
  await trySim('Batch complet (non signé)', { ...noSig, BatchSigners: undefined })
  for (const [l, r] of sims) console.log(`    ${l.padEnd(30)} ${r}`)
  R.push({ cas: 'C29', question: 'couverture de `simulate`',
    reponse: sims.map(([l, r]) => `${l}: ${r}`).join(' · '),
    verdict: 'ce que le preflight peut et ne peut pas simuler' })
}

console.log('\n══ C30/31 · La réserve réelle de l\'acheteur, au drop près ══')
{
  // Deux acheteurs jetables, membres, financés à ~8 XRP.
  const mk = async () => {
    const w = await fundFromTreasury(c, W.treasury, '8000000')
    await issueCredentialRaw(c, W.issuer, w.classicAddress, 'KYC')
    await acceptCredential(c, w, W.issuer, 'KYC')
    return w
  }
  const b1 = await mk(), b2 = await mk()
  await sleep(2000)

  // hypothèse : après paiement l'acheteur doit garder ≥ base(1) + owner(0,2) = 1,2 XRP
  const runAt = async (buyer, keep) => {
    const bal = await xrpBalance(c, buyer.classicAddress)
    const price = bal - keep
    const b = await swapBatch(c, { seller: W.seller1, buyer, mptId: V1.mptId,
      shares: 10_000, price: price.toString(), authorize: true })
    const r = await sendRaw(c, b)
    await sleep(3000)
    const got = (await shareBalance(c, buyer.classicAddress, V1.mptId)).amount
    return { bal, price, r, got }
  }
  const exact = await runAt(b1, 1_200_000n)          // garde exactement 1,2 XRP
  const below = await runAt(b2, 1_199_999n)          // 1 drop de moins
  console.log(`    garde 1,200000 XRP : batch ${exact.r.engine}→${exact.r.validated} · parts reçues ${exact.got}`)
  console.log(`    garde 1,199999 XRP : batch ${below.r.engine}→${below.r.validated} · parts reçues ${below.got}`)
  note('C30', 'seuil exact de solde acheteur (nouvel objet MPToken)',
    `à 1,2 XRP restants: ${exact.got > 0n ? 'PASSE' : 'échoue'} · à 1 drop de moins: ${below.got > 0n ? 'passe' : 'ÉCHOUE silencieusement'}`,
    exact.got > 0n && below.got === 0n
      ? 'le seuil est réserve base 1 XRP + 0,2 XRP (objet MPToken) exactement — la marge de 2 XRP du preflight est sûre mais opaque'
      : 'seuil différent de l\'hypothèse — voir les codes')
}

console.log('\n══ C32 · COURSE : les parts bougent entre le preflight et la soumission ══')
{
  const p = await pf({ vaultId: V1.vaultId, seller: W.seller2.classicAddress,
    buyer: W.buyer1.classicAddress, shares: 900_000, price: 800_000 })
  const b = await swapBatch(c, { seller: W.seller2, buyer: W.buyer1, mptId: V1.mptId,
    shares: 900_000, price: 800_000, authorize: p.needsAuthorize })
  // pendant ce temps, le vendeur déplace presque tout (il reste ~1M hors escrow)
  const sb = await shareBalance(c, W.seller2.classicAddress, V1.mptId)
  const mv = await submit(c, { TransactionType: 'Payment', Account: W.seller2.classicAddress,
    Destination: W.seller1.classicAddress, Amount: { mpt_issuance_id: V1.mptId, value: (sb.amount - 100_000n).toString() } }, W.seller2)
  const before = await photo(c, V1.mptId, { buyer1: W.buyer1.classicAddress })
  const r = await sendRaw(c, b)
  await sleep(3000)
  const d = diffPhoto(before, await photo(c, V1.mptId, { buyer1: W.buyer1.classicAddress }))
  note('C32', 'preflight OK puis le vendeur déplace ses parts avant soumission',
    `preflight ok=${p.ok} · déplacement ${mv.result} · batch ${r.engine}→${r.validated} · parts livrées=${d.buyer1.shares} · XRP payés=${-d.buyer1.xrp}`,
    d.buyer1.shares === 0n ? 'échec silencieux tesSUCCESS — SEULE la réconciliation des soldes le voit' : 'le swap est passé')
}

recap(R, 'CAMPAGNE C — PREFLIGHT')
await c.disconnect()
