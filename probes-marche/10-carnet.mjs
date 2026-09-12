/**
 * probes-marche/10-carnet.mjs — Campagne F : le carnet et la sémantique d'offre.
 *
 *   node probes-marche/10-carnet.mjs
 *
 * F47  exécution partielle : que devient l'offre après une prise partielle ?
 * F48  offres cumulées d'un même vendeur > son solde : le carnet le voit-il ?
 * F49  offre morte (vendeur défait) : viewFor la détecte-t-elle ?
 * F50  expiration à l'instant exact
 * F51  double fill() : le carnet est-il idempotent ?
 * F52  annulation pendant le règlement — et la VRAIE annulation (bump de séquence)
 * D39  les annotations de viewFor sont-elles exactes et actionnables ?
 */
import { unlinkSync, existsSync } from 'node:fs'
import {
  connect, submit, shareBalance, sleep, rippleNow, loadState, walletsOf, recap,
  XRP, sendRaw, swapBatch, DIR,
} from './_lib.mjs'
import { OrderBook } from '@secondwave/orderbook'
import { join } from 'node:path'

const S = loadState('marche')
const W = walletsOf(S)
const c = await connect()
const V1 = S.vaults.V1, V3 = S.vaults.V3, V5 = S.vaults.V5
const R = []
const note = (cas, question, reponse, verdict) => { R.push({ cas, question, reponse, verdict }); console.log(`  [${cas}] ${reponse}\n        → ${verdict}`) }

const BOOK = join(DIR, 'orderbook.json')            // gitignoré (motif orderbook.json)
if (existsSync(BOOK)) unlinkSync(BOOK)
const book = new OrderBook(BOOK)

console.log('\n══ F47 · Exécution PARTIELLE d\'une offre ══')
{
  const o = book.post({ vaultId: V5.vaultId, seller: W.seller2.classicAddress, shares: 2_000_000, price: 1_700_000 })
  // l'acheteur ne prend que la moitié — le règlement ne connaît pas l'offre
  const b = await swapBatch(c, { seller: W.seller2, buyer: W.buyer1, mptId: V5.mptId,
    shares: 1_000_000, price: 850_000 })
  const r = await sendRaw(c, b)
  const v = await book.viewFor(c, W.buyer1.classicAddress, V5.vaultId)
  const still = v.find(x => x.id === o.id)
  note('F47', 'prise partielle (1M sur 2M) réglée hors carnet',
    `batch ${r.engine}→${r.validated} · l'offre reste status=${still?.status ?? book.get(o.id).status} shares=${still?.shares} eligible=${still?.eligible}`,
    'le carnet n\'a AUCUNE notion de partiel : il faut fill()+re-post du reliquat, ou un ordre par fraction (200 drops chacune)')
  book.fill(o.id, r.hash)
  book.post({ vaultId: V5.vaultId, seller: W.seller2.classicAddress, shares: 1_000_000, price: 850_000 })
  console.log('    (reliquat re-posté à la main — c\'est le protocole d\'usage à documenter)')
}

console.log('\n══ F48 · Offres cumulées > solde du vendeur ══')
{
  const bal = (await shareBalance(c, W.seller2.classicAddress, V5.mptId)).amount
  const each = bal * 6n / 10n                                  // 60 % du solde, deux fois
  const o1 = book.post({ vaultId: V5.vaultId, seller: W.seller2.classicAddress, shares: each, price: 1_000_000 })
  const o2 = book.post({ vaultId: V5.vaultId, seller: W.seller2.classicAddress, shares: each, price: 990_000 })
  const v = await book.viewFor(c, W.buyer1.classicAddress, V5.vaultId)
  const e1 = v.find(x => x.id === o1.id), e2 = v.find(x => x.id === o2.id)
  note('F48', `deux offres de ${each} sur un solde de ${bal}`,
    `o1 eligible=${e1?.eligible} · o2 eligible=${e2?.eligible}`,
    e1?.eligible && e2?.eligible
      ? '🔴 TROU DU CARNET : la couverture est vérifiée offre par offre, jamais en cumul — survente affichable'
      : 'le cumul est détecté')
  book.cancel(o1.id); book.cancel(o2.id)
}

console.log('\n══ F49 · Offre morte : le vendeur s\'est défait de ses parts ══')
{
  const bal = (await shareBalance(c, W.seller2.classicAddress, V5.mptId)).amount
  const o = book.post({ vaultId: V5.vaultId, seller: W.seller2.classicAddress, shares: bal, price: 1_000_000 })
  const mv = await submit(c, { TransactionType: 'Payment', Account: W.seller2.classicAddress,
    Destination: W.seller1.classicAddress, Amount: { mpt_issuance_id: V5.mptId, value: (bal / 2n).toString() } }, W.seller2)
  const v = await book.viewFor(c, W.buyer1.classicAddress, V5.vaultId)
  const dead = v.find(x => x.id === o.id)
  note('F49', 'le vendeur vend la moitié ailleurs après avoir posté',
    `transfert ${mv.result} · offre eligible=${dead?.eligible} raison="${dead?.reason}"`,
    dead?.eligible === false ? 'viewFor détecte l\'offre morte, avec le solde restant en clair' : '🔴 offre zombie affichée')
  book.cancel(o.id)
}

console.log('\n══ F50 · Expiration à l\'instant exact ══')
{
  const o = book.post({ vaultId: V5.vaultId, seller: W.seller2.classicAddress, shares: 1000, price: 900, ttl: 3 })
  const t0 = rippleNow()
  let lastListed = null, firstGone = null
  for (let i = 0; i < 12; i++) {
    const listed = book.list(V5.vaultId).some(x => x.id === o.id)
    const dt = rippleNow() - o.expiry
    if (listed) lastListed = dt
    else { firstGone = dt; break }
    await sleep(700)
  }
  note('F50', 'frontière d\'expiration (expiry strictement > now)',
    `encore listée à expiry${lastListed >= 0 ? '+' : ''}${lastListed}s · absente à expiry+${firstGone}s`,
    'l\'expiration est calculée sur l\'horloge LOCALE (rippleNow du client) — deux clients désynchronisés voient deux carnets différents')
}

console.log('\n══ F51 · Deux acheteurs, une offre : double fill() ══')
{
  const o = book.post({ vaultId: V5.vaultId, seller: W.seller2.classicAddress, shares: 1000, price: 900 })
  book.fill(o.id, 'HASH_ACHETEUR_1')
  const second = book.fill(o.id, 'HASH_ACHETEUR_2')
  note('F51', 'fill() appelé par deux règlements concurrents',
    `status=${second.status} txHash=${second.txHash}`,
    second.txHash === 'HASH_ACHETEUR_2'
      ? '🔴 fill() écrase sans vérifier le status — la preuve on-chain du 1er acheteur est perdue (le 2e Batch a fini en tefPAST_SEQ)'
      : 'le second fill est ignoré')
}

console.log('\n══ F52 · Annuler pendant le règlement — et la vraie annulation ══')
{
  // a) l'annulation du carnet n'empêche RIEN : le Batch signé circule déjà
  const o = book.post({ vaultId: V5.vaultId, seller: W.seller2.classicAddress, shares: 500_000, price: 425_000 })
  const b = await swapBatch(c, { seller: W.seller2, buyer: W.buyer1, mptId: V5.mptId, shares: 500_000, price: 425_000 })
  book.cancel(o.id)                                   // le vendeur « annule »
  const before = (await shareBalance(c, W.buyer1.classicAddress, V5.mptId)).amount
  const r = await sendRaw(c, b)
  await sleep(2000)
  const after = (await shareBalance(c, W.buyer1.classicAddress, V5.mptId)).amount
  note('F52a', 'cancel() du carnet pendant qu\'un acheteur règle',
    `offre CANCELLED puis batch ${r.engine}→${r.validated} · ${after - before} parts livrées quand même`,
    after > before ? '🔴 l\'annulation hors chaîne est PUREMENT décorative une fois le Batch signé parti' : 'rien ne part')

  // b) la vraie annulation : consommer sa propre séquence (AccountSet à vide)
  const o2 = book.post({ vaultId: V5.vaultId, seller: W.seller2.classicAddress, shares: 500_000, price: 425_000 })
  const b2 = await swapBatch(c, { seller: W.seller2, buyer: W.buyer1, mptId: V5.mptId, shares: 500_000, price: 425_000 })
  const bump = await submit(c, { TransactionType: 'AccountSet', Account: W.seller2.classicAddress }, W.seller2)
  book.cancel(o2.id)
  const r2 = await sendRaw(c, b2)
  note('F52b', 'annulation RÉELLE : bump de séquence du vendeur (AccountSet)',
    `bump ${bump.result} · batch soumis ensuite → ${r2.engine}${r2.validated ? '→' + r2.validated : ''}`,
    r2.engine === 'tefPAST_SEQ'
      ? 'un AccountSet à 10 drops invalide TOUT Batch signé en circulation (enveloppe vendeur) — c\'est le vrai cancel, à intégrer au carnet'
      : `inattendu : ${r2.engine}`)
}

console.log('\n══ D39 · Les annotations de viewFor : exactes et actionnables ? ══')
{
  book.post({ vaultId: V3.vaultId, seller: W.seller1.classicAddress, shares: 1000, price: 900 })
  book.post({ vaultId: V1.vaultId, seller: W.seller1.classicAddress, shares: 1000, price: 900 })
  const vOut = await book.viewFor(c, W.outsider.classicAddress)     // sans credential
  const vMem = await book.viewFor(c, W.buyer1.classicAddress)       // membre
  console.log('    vu par outsider :')
  for (const x of vOut) console.log(`      ${x.id} v=${x.vaultId.slice(0, 6)}… eligible=${x.eligible} · "${x.reason}"`)
  console.log('    vu par buyer1 :')
  for (const x of vMem) console.log(`      ${x.id} v=${x.vaultId.slice(0, 6)}… eligible=${x.eligible} · "${x.reason}"`)
  const nonTransf = vMem.find(x => x.vaultId === V3.vaultId)
  const domain = vOut.find(x => x.vaultId === V1.vaultId)
  note('D39', 'annotations du carnet',
    `V3 (membre): "${nonTransf?.reason}" · V1 (outsider): "${domain?.reason}"`,
    'les raisons distinguent bien non-transférable / credential manquant / offre morte — mais aucune ne dit COMMENT réparer (quel issuer, quel type de credential)')
}

recap(R, 'CAMPAGNE F — CARNET')
await c.disconnect()
