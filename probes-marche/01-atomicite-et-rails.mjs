/**
 * probes-marche/01 — les questions qui décident du design.
 *
 *   node probes-marche/01-atomicite-et-rails.mjs
 *
 * Cinq sondes, dans l'ordre d'importance :
 *
 *   1. ATOMICITÉ      tfAllOrNothing tient-il quand la jambe du prix échoue ?
 *                     Tout le produit repose là-dessus.
 *   2. ALTÉRATION     le vendeur peut-il changer le prix APRÈS la signature de
 *                     l'acheteur ? (piste de sécurité)
 *   3. LE GATE        le domaine s'applique-t-il aux transferts de parts, ou
 *                     seulement aux dépôts ?
 *   4. LES DRAPEAUX   tfAllOrNothing · tfOnlyOne · tfUntilFailure · tfIndependent
 *                     sur le MÊME swap cassé — matrice comparative.
 *   5. LES RAILS      Check, Escrow, DEX : que peut-on faire d'autre avec un MPT ?
 *
 * Tourne sur le monde de `npm run world`. Ne le modifie pas de façon destructive :
 * les échanges portent sur de petites quantités.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { BatchFlags, signMultiBatch } from 'xrpl'
import { encode, encodeForSigning } from 'ripple-binary-codec'
import { sign as kpSign } from 'ripple-keypairs'
import {
  connect, Wallet, fundAccount, submit, sequence, readVault,
  shareBalance, xrpBalance, sleep, txUrl, rippleNow,
} from '@secondwave/core'
import { issueCredential } from '@secondwave/vault'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const world = JSON.parse(readFileSync(join(ROOT, 'world.json'), 'utf8'))
const seeds = JSON.parse(readFileSync(join(ROOT, 'state.json'), 'utf8'))

const TF_INNER = 0x40000000
const XRP = d => (Number(d) / 1e6).toFixed(6)
const resultats = []
const note = (sonde, question, reponse, verdict) =>
  resultats.push({ sonde, question, reponse, verdict })

const v0 = world.vaults.find(x => x.key === 'sain')
const deposants = seeds.vaults.sain.depositors.map(s => Wallet.fromSeed(s))
const issuer = Wallet.fromSeed(seeds.issuer)
const intrus = Wallet.fromSeed(seeds.nonMember)

const c = await connect(world.network)
const vault = await readVault(c, v0.vaultId)
const MPT = vault.ShareMPTID

// Le vendeur est celui qui détient le plus de parts aujourd'hui.
const soldes = []
for (const w of deposants) soldes.push([w, (await shareBalance(c, w.classicAddress, MPT)).amount])
soldes.sort((a, b) => (b[1] > a[1] ? 1 : -1))
const vendeur = soldes[0][0]
const acheteur = soldes[1][0]

console.log(`vault  ${v0.vaultId}`)
console.log(`parts  ${MPT}`)
console.log(`vendeur  ${vendeur.classicAddress}  ${soldes[0][1]} parts`)
console.log(`acheteur ${acheteur.classicAddress}  ${soldes[1][1]} parts`)

// ─────────────────────────────────────────────────────────────
// Outils
// ─────────────────────────────────────────────────────────────
const leg = t => ({ RawTransaction: { ...t, Fee: '0', SigningPubKey: '', Flags: TF_INNER } })

/** Construit un Batch de swap non signé. */
async function swapBatch({ seller, buyer, shares, price, flags = BatchFlags.tfAllOrNothing, authorize = false }) {
  const sSeq = await sequence(c, seller.classicAddress)
  let bSeq = await sequence(c, buyer.classicAddress)
  const li = (await c.request({ command: 'ledger', ledger_index: 'validated' })).result.ledger_index
  const inner = []
  if (authorize)
    inner.push(leg({ TransactionType: 'MPTokenAuthorize', Account: buyer.classicAddress,
                     MPTokenIssuanceID: MPT, Sequence: bSeq++ }))
  inner.push(leg({ TransactionType: 'Payment', Account: seller.classicAddress,
                   Destination: buyer.classicAddress,
                   Amount: { mpt_issuance_id: MPT, value: String(shares) }, Sequence: sSeq + 1 }))
  inner.push(leg({ TransactionType: 'Payment', Account: buyer.classicAddress,
                   Destination: seller.classicAddress, Amount: String(price), Sequence: bSeq++ }))
  return {
    TransactionType: 'Batch', Account: seller.classicAddress, Flags: flags,
    RawTransactions: inner, Sequence: sSeq,
    Fee: String(50 * (inner.length + 1)), LastLedgerSequence: li + 25,
  }
}

function signer(batch, seller) {
  batch.SigningPubKey = seller.publicKey
  batch.TxnSignature = kpSign(encodeForSigning(batch), seller.privateKey)
  return batch
}

async function envoyer(batch) {
  let r
  try {
    r = await c.request({ command: 'submit', tx_blob: encode(batch) })
  } catch (e) {
    // Un rejet local (signature invalide, malformé) remonte en exception.
    return { engine: e.data?.error ?? 'error', message: e.data?.error_exception ?? e.message }
  }
  const hash = r.result.tx_json?.hash
  if (r.result.engine_result !== 'tesSUCCESS')
    return { engine: r.result.engine_result, message: r.result.engine_result_message, hash }
  for (let i = 0; i < 20; i++) {
    await sleep(2000)
    try {
      const t = await c.request({ command: 'tx', transaction: hash })
      if (t.result.validated)
        return { engine: r.result.engine_result, validated: t.result.meta?.TransactionResult,
                 meta: t.result.meta, ledgerIndex: t.result.ledger_index, hash }
    } catch { /* pas encore */ }
  }
  return { engine: r.result.engine_result, validated: 'timeout', hash }
}

const photo = async (a, b) => ({
  vParts: (await shareBalance(c, a.classicAddress, MPT)).amount,
  aParts: (await shareBalance(c, b.classicAddress, MPT)).amount,
  vXrp: await xrpBalance(c, a.classicAddress),
  aXrp: await xrpBalance(c, b.classicAddress),
})

const diff = (av, ap) => ({
  parts: ap.aParts - av.aParts,
  vendues: av.vParts - ap.vParts,
  paye: av.aXrp - ap.aXrp,
})

// ═════════════════════════════════════════════════════════════
console.log('\n\n════ SONDE 1 — ATOMICITÉ : la jambe du prix échoue ════\n')
// L'acheteur n'a pas 500 XRP. La jambe 3 doit échouer.
// Question : la jambe 2 (les parts) est-elle annulée ?
{
  const PARTS = '2000000', PRIX = '500000000'   // 500 XRP, hors de portée
  const av = await photo(vendeur, acheteur)
  console.log(`  acheteur : ${XRP(av.aXrp)} XRP · prix demandé ${XRP(PRIX)} XRP → la jambe 3 DOIT échouer`)

  const b = signer(await swapBatch({ seller: vendeur, buyer: acheteur, shares: PARTS, price: PRIX }), vendeur)
  signMultiBatch(acheteur, b)
  const r = await envoyer(b)
  await sleep(4000)
  const ap = await photo(vendeur, acheteur)
  const d = diff(av, ap)

  console.log(`  soumission        : ${r.engine}`)
  console.log(`  résultat validé   : ${r.validated ?? '—'}`)
  console.log(`  nœuds dans la meta: ${r.meta?.AffectedNodes?.length ?? '—'}`)
  console.log(`  parts déplacées   : ${d.parts}`)
  console.log(`  XRP payés         : ${XRP(d.paye)}`)

  const intact = d.parts === 0n && d.vendues === 0n
  console.log(`\n  → ${intact ? '✅ ROLLBACK COMPLET — tfAllOrNothing tient' : '🔴 LES PARTS ONT BOUGÉ SANS PAIEMENT'}`)
  note('1 atomicité', 'tfAllOrNothing annule-t-il tout si la jambe du prix échoue ?',
    `${r.validated ?? r.engine} · ${d.parts} part déplacée · meta à ${r.meta?.AffectedNodes?.length ?? '?'} nœud(s)`,
    intact ? 'conforme — le produit repose sur du solide' : 'BUG MAJEUR')

  if (r.meta) {
    console.log(`\n  meta brute du Batch (pièce à conviction) :`)
    console.log('  ' + JSON.stringify(r.meta, null, 1).split('\n').join('\n  ').slice(0, 900))
  }
}

// ═════════════════════════════════════════════════════════════
console.log('\n\n════ SONDE 2 — ALTÉRATION : changer le prix après signature ════\n')
// L'acheteur signe pour 3 XRP. Le vendeur réécrit la jambe à 30 XRP et soumet.
{
  const PARTS = '1000000', PRIX_SIGNE = '3000000', PRIX_TRICHE = '30000000'
  const av = await photo(vendeur, acheteur)

  const b = await swapBatch({ seller: vendeur, buyer: acheteur, shares: PARTS, price: PRIX_SIGNE })
  signMultiBatch(acheteur, b)                       // l'acheteur signe 3 XRP
  console.log(`  acheteur signe    : ${XRP(PRIX_SIGNE)} XRP`)

  // le vendeur réécrit la jambe du prix APRÈS coup
  b.RawTransactions[1].RawTransaction.Amount = PRIX_TRICHE
  console.log(`  vendeur réécrit à : ${XRP(PRIX_TRICHE)} XRP`)
  signer(b, vendeur)

  const r = await envoyer(b)
  await sleep(4000)
  const ap = await photo(vendeur, acheteur)
  const d = diff(av, ap)

  console.log(`  soumission        : ${r.engine} ${r.message ? '— ' + r.message : ''}`)
  console.log(`  résultat validé   : ${r.validated ?? '—'}`)
  console.log(`  XRP réellement payés par l'acheteur : ${XRP(d.paye)}`)

  const protege = r.validated !== 'tesSUCCESS' || d.paye < BigInt(PRIX_TRICHE) / 2n
  console.log(`\n  → ${protege ? '✅ les BatchSigners protègent l\'acheteur' : '🔴 LE VENDEUR A PU CHANGER LE PRIX'}`)
  note('2 altération', 'le vendeur peut-il réécrire le prix après la signature de l\'acheteur ?',
    `${r.engine}${r.validated ? ' → ' + r.validated : ''} · payé ${XRP(d.paye)} XRP au lieu de ${XRP(PRIX_SIGNE)}`,
    protege ? 'conforme — la signature couvre les jambes' : 'PISTE DE SÉCURITÉ')
}

// ═════════════════════════════════════════════════════════════
console.log('\n\n════ SONDE 3 — LE GATE : transfert direct vers un non-membre ════\n')
// Le domaine bloque le dépôt (tecNO_AUTH mesuré). Bloque-t-il le TRANSFERT ?
{
  console.log(`  3a. Payment direct de parts vers un MEMBRE (hors Batch)`)
  const r1 = await submit(c, {
    TransactionType: 'Payment', Account: vendeur.classicAddress,
    Destination: acheteur.classicAddress,
    Amount: { mpt_issuance_id: MPT, value: '500000' },
  }, vendeur)
  console.log(`      → ${r1.result}`)
  note('3 gate', 'un Payment simple de parts entre membres passe-t-il, hors Batch ?',
    r1.result, r1.ok ? 'oui — le Batch ne sert QUE à l\'atomicité du prix' : 'non')

  console.log(`\n  3b. Le non-membre autorise le MPT`)
  const r2 = await submit(c, {
    TransactionType: 'MPTokenAuthorize', Account: intrus.classicAddress, MPTokenIssuanceID: MPT,
  }, intrus)
  console.log(`      → ${r2.result}`)
  note('3 gate', 'un non-membre du domaine peut-il faire MPTokenAuthorize sur les parts ?',
    r2.result, r2.ok ? 'oui — l\'autorisation n\'est pas gatée, seul le transfert l\'est' : 'non')

  console.log(`\n  3c. Payment direct de parts vers le NON-MEMBRE`)
  const r3 = await submit(c, {
    TransactionType: 'Payment', Account: vendeur.classicAddress,
    Destination: intrus.classicAddress,
    Amount: { mpt_issuance_id: MPT, value: '500000' },
  }, vendeur)
  const recu = (await shareBalance(c, intrus.classicAddress, MPT)).amount
  console.log(`      → ${r3.result} · parts détenues par l'intrus : ${recu}`)
  note('3 gate', 'le domaine bloque-t-il le TRANSFERT de parts, pas seulement le dépôt ?',
    `${r3.result} · intrus détient ${recu} parts`,
    recu === 0n ? 'le gate couvre les transferts — indispensable au produit'
                : 'TROU : un non-membre peut recevoir des parts par transfert')
}

// ═════════════════════════════════════════════════════════════
console.log('\n\n════ SONDE 4 — LES DRAPEAUX DE BATCH sur le même swap cassé ════\n')
// Même swap impayable, sous chaque flag. Ce qui s'applique change-t-il ?
{
  const DRAPEAUX = [
    ['tfAllOrNothing', BatchFlags.tfAllOrNothing],
    ['tfOnlyOne', BatchFlags.tfOnlyOne],
    ['tfUntilFailure', BatchFlags.tfUntilFailure],
    ['tfIndependent', BatchFlags.tfIndependent],
  ]
  for (const [nom, flag] of DRAPEAUX) {
    if (flag === undefined) { console.log(`  ${nom.padEnd(16)} absent du SDK`); continue }
    const av = await photo(vendeur, acheteur)
    const b = signer(await swapBatch({
      seller: vendeur, buyer: acheteur, shares: '300000', price: '500000000', flags: flag,
    }), vendeur)
    signMultiBatch(acheteur, b)
    const r = await envoyer(b)
    await sleep(4000)
    const d = diff(av, await photo(vendeur, acheteur))
    const ligne = `${r.engine}${r.validated ? ' → ' + r.validated : ''} · parts déplacées ${d.parts} · payé ${XRP(d.paye)}`
    console.log(`  ${nom.padEnd(16)} ${ligne}`)
    note('4 drapeaux', `${nom} avec une jambe de prix impayable`, ligne,
      d.parts === 0n ? 'rien ne s\'applique' : '⚠️ les parts partent sans paiement')
  }
}

// ═════════════════════════════════════════════════════════════
console.log('\n\n════ SONDE 5 — LES AUTRES RAILS pour un MPT ════\n')
// Le Batch est-il la seule voie ? Check, Escrow, DEX.
{
  const parts = { mpt_issuance_id: MPT, value: '100000' }

  console.log(`  5a. CheckCreate avec des parts en SendMax`)
  const r1 = await submit(c, {
    TransactionType: 'CheckCreate', Account: vendeur.classicAddress,
    Destination: acheteur.classicAddress, SendMax: parts,
  }, vendeur)
  console.log(`      → ${r1.result}${r1.message ? ' — ' + r1.message : ''}`)
  note('5 rails', 'CheckCreate accepte-t-il un MPT ?', r1.result,
    r1.ok ? 'rail alternatif viable' : 'fermé')

  console.log(`\n  5b. EscrowCreate avec des parts`)
  const r2 = await submit(c, {
    TransactionType: 'EscrowCreate', Account: vendeur.classicAddress,
    Destination: acheteur.classicAddress, Amount: parts,
    FinishAfter: rippleNow() + 120, CancelAfter: rippleNow() + 600,
  }, vendeur)
  console.log(`      → ${r2.result}${r2.message ? ' — ' + r2.message : ''}`)
  note('5 rails', 'EscrowCreate accepte-t-il un MPT ?', r2.result,
    r2.ok ? 'rail alternatif viable — négociation différée possible' : 'fermé')

  console.log(`\n  5c. OfferCreate sur le DEX natif avec des parts`)
  const r3 = await submit(c, {
    TransactionType: 'OfferCreate', Account: vendeur.classicAddress,
    TakerGets: parts, TakerPays: '90000',
  }, vendeur)
  console.log(`      → ${r3.result}${r3.message ? ' — ' + r3.message : ''}`)
  note('5 rails', 'le DEX natif accepte-t-il un MPT (XLS-82 ?) ', r3.result,
    r3.ok ? '⚠️ le marché P2P perd son intérêt' : 'fermé aujourd\'hui — le marché P2P a sa raison d\'être')

  console.log(`\n  5d. PaymentChannelCreate avec des parts`)
  const r4 = await submit(c, {
    TransactionType: 'PaymentChannelCreate', Account: vendeur.classicAddress,
    Destination: acheteur.classicAddress, Amount: parts,
    SettleDelay: 60, PublicKey: vendeur.publicKey,
  }, vendeur)
  console.log(`      → ${r4.result}${r4.message ? ' — ' + r4.message : ''}`)
  note('5 rails', 'PaymentChannelCreate accepte-t-il un MPT ?', r4.result, r4.ok ? 'viable' : 'fermé')

  console.log(`\n  5e. Un VaultWithdraw dans un Batch (échappatoire supposée fermée)`)
  const sSeq = await sequence(c, vendeur.classicAddress)
  const li = (await c.request({ command: 'ledger', ledger_index: 'validated' })).result.ledger_index
  const b = signer({
    TransactionType: 'Batch', Account: vendeur.classicAddress, Flags: BatchFlags.tfAllOrNothing,
    RawTransactions: [
      leg({ TransactionType: 'VaultWithdraw', Account: vendeur.classicAddress, VaultID: v0.vaultId,
            Amount: { mpt_issuance_id: MPT, value: '100000' }, Sequence: sSeq + 1 }),
      leg({ TransactionType: 'AccountSet', Account: vendeur.classicAddress, Sequence: sSeq + 2 }),
    ],
    Sequence: sSeq, Fee: '150', LastLedgerSequence: li + 25,
  }, vendeur)
  let res5e
  try {
    const r = await c.request({ command: 'submit', tx_blob: encode(b) })
    res5e = `${r.result.engine_result} — ${r.result.engine_result_message}`
  } catch (e) { res5e = e.data?.error_message ?? e.message }
  console.log(`      → ${res5e}`)
  note('5 rails', 'peut-on mettre un VaultWithdraw dans un Batch ?', res5e,
    'confirme kDisabledTxTypes — pas d\'échappatoire à la phase Investment')
}

// ═════════════════════════════════════════════════════════════
console.log('\n\n════════════════════ RÉCAPITULATIF ════════════════════\n')
for (const r of resultats) {
  console.log(`  [${r.sonde}]`)
  console.log(`    Q : ${r.question}`)
  console.log(`    R : ${r.reponse}`)
  console.log(`    → ${r.verdict}\n`)
}

await c.disconnect()
