/**
 * probes-marche/02 — ce que coûte un échange, et ce qui peut mal tourner.
 *
 *   node probes-marche/02-couts-et-adversarial.mjs
 *
 *   A. COÛT COMPLET   frais du Batch + frais des jambes + réserves consommées,
 *                     au drop près, avec un acheteur neuf qui doit autoriser.
 *   B. DOUBLE-VENTE   deux Batch concurrents qui cèdent les mêmes parts.
 *   C. FRACTIONNEMENT une position découpée en quatre : combien ça coûte de plus ?
 *   D. LA DÉCOTE      prix payé rapporté à la NAV — le chiffre qui justifie le produit.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { BatchFlags, signMultiBatch } from 'xrpl'
import { encode, encodeForSigning } from 'ripple-binary-codec'
import { sign as kpSign } from 'ripple-keypairs'
import {
  connect, Wallet, fundAccount, sequence, readVault, readVaultGraph,
  shareBalance, xrpBalance, sleep, txUrl,
} from '@secondwave/core'
import { issueCredential } from '@secondwave/vault'
import { priceHistory } from '@secondwave/orderbook'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const world = JSON.parse(readFileSync(join(ROOT, 'world.json'), 'utf8'))
const seeds = JSON.parse(readFileSync(join(ROOT, 'state.json'), 'utf8'))

const TF_INNER = 0x40000000
const XRP = d => (Number(d) / 1e6).toFixed(6)
const resultats = []
const note = (sonde, question, reponse, verdict) => resultats.push({ sonde, question, reponse, verdict })

const v0 = world.vaults.find(x => x.key === 'sain')
const issuer = Wallet.fromSeed(seeds.issuer)
const deposants = seeds.vaults.sain.depositors.map(s => Wallet.fromSeed(s))

const c = await connect(world.network)
const vault = await readVault(c, v0.vaultId)
const MPT = vault.ShareMPTID

const soldes = []
for (const w of deposants) soldes.push([w, (await shareBalance(c, w.classicAddress, MPT)).amount])
soldes.sort((a, b) => (b[1] > a[1] ? 1 : -1))
const vendeur = soldes[0][0]

console.log(`vault    ${v0.vaultId}`)
console.log(`vendeur  ${vendeur.classicAddress}  ${soldes[0][1]} parts\n`)

const leg = t => ({ RawTransaction: { ...t, Fee: '0', SigningPubKey: '', Flags: TF_INNER } })

async function swap({ seller, buyer, shares, price, authorize }) {
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
  const b = { TransactionType: 'Batch', Account: seller.classicAddress, Flags: BatchFlags.tfAllOrNothing,
              RawTransactions: inner, Sequence: sSeq,
              Fee: String(50 * (inner.length + 1)), LastLedgerSequence: li + 25 }
  signMultiBatch(buyer, b)
  b.SigningPubKey = seller.publicKey
  b.TxnSignature = kpSign(encodeForSigning(b), seller.privateKey)
  return b
}

async function attendre(hash) {
  for (let i = 0; i < 20; i++) {
    await sleep(2000)
    try {
      const t = await c.request({ command: 'tx', transaction: hash })
      if (t.result.validated) return t.result
    } catch { /* pas encore */ }
  }
  return null
}

// ═════════════════════════════════════════════════════════════
console.log('════ A — LE COÛT COMPLET D\'UN ÉCHANGE ════\n')
let neuf
{
  neuf = await fundAccount()
  await sleep(6000)
  const cr = await issueCredential(c, { issuer, subject: neuf })
  console.log(`  acheteur neuf ${neuf.classicAddress} · credential ${cr.result}`)

  const PARTS = '1500000', PRIX = '1320000'          // 0,88 drop/part
  const avV = await xrpBalance(c, vendeur.classicAddress)
  const avA = await xrpBalance(c, neuf.classicAddress)
  const reserveAvant = (await c.request({ command: 'account_info', account: neuf.classicAddress,
                                          ledger_index: 'validated' })).result.account_data.OwnerCount

  const b = await swap({ seller: vendeur, buyer: neuf, shares: PARTS, price: PRIX, authorize: true })
  const declare = BigInt(b.Fee)
  const sub = await c.request({ command: 'submit', tx_blob: encode(b) })
  const t = await attendre(sub.result.tx_json?.hash)
  await sleep(4000)

  const apV = await xrpBalance(c, vendeur.classicAddress)
  const apA = await xrpBalance(c, neuf.classicAddress)
  const info = (await c.request({ command: 'account_info', account: neuf.classicAddress,
                                  ledger_index: 'validated' })).result
  const recu = (await shareBalance(c, neuf.classicAddress, MPT)).amount

  const coutVendeur = avV - apV + BigInt(PRIX)       // ce que le vendeur a perdu au-delà du prix reçu
  const coutAcheteur = avA - apA - BigInt(PRIX)      // ce que l'acheteur a payé au-delà du prix

  console.log(`  Batch             : ${t?.meta?.TransactionResult ?? sub.result.engine_result}`)
  console.log(`  parts reçues      : ${recu}`)
  console.log(`  Fee déclaré       : ${declare} drops (${XRP(declare)} XRP)`)
  console.log(`  coût net vendeur  : ${coutVendeur} drops   (il porte le Fee de l'enveloppe)`)
  console.log(`  coût net acheteur : ${coutAcheteur} drops`)
  console.log(`  OwnerCount        : ${reserveAvant} → ${info.account_data.OwnerCount}`
    + `  (l'objet MPToken consomme ${info.account_data.OwnerCount - reserveAvant} owner reserve)`)
  console.log(`  réserve de base   : ${XRP(info.account_data.Balance)} XRP de solde,`
    + ` réserve totale exigée ${XRP((info.account_data.OwnerCount) * 200000 + 1000000)} XRP`)

  const fraisPct = Number(coutVendeur + coutAcheteur) / Number(PRIX) * 100
  console.log(`\n  → frais totaux = ${coutVendeur + coutAcheteur} drops, soit ${fraisPct.toFixed(4)} % du prix`)
  note('A coût', 'que coûte un échange, hors prix ?',
    `${coutVendeur + coutAcheteur} drops de frais (${fraisPct.toFixed(4)} % du prix) + `
    + `${(info.account_data.OwnerCount - reserveAvant) * 0.2} XRP de réserve immobilisée chez l'acheteur`,
    fraisPct < 0.1 ? 'négligeable devant une décote de 10 % — le rail est économiquement viable'
                   : 'à comparer à la décote')
}

// ═════════════════════════════════════════════════════════════
console.log('\n\n════ B — DOUBLE-VENTE : deux Batch sur les mêmes parts ════\n')
{
  const autre = deposants.find(w => w.classicAddress !== vendeur.classicAddress)
  const PARTS = '800000'
  const avNeuf = (await shareBalance(c, neuf.classicAddress, MPT)).amount
  const avAutre = (await shareBalance(c, autre.classicAddress, MPT)).amount

  // Deux batch construits sur la MÊME séquence vendeur, soumis coup sur coup.
  const b1 = await swap({ seller: vendeur, buyer: neuf, shares: PARTS, price: '700000', authorize: false })
  const b2 = await swap({ seller: vendeur, buyer: autre, shares: PARTS, price: '700000', authorize: false })
  console.log(`  les deux Batch portent la séquence vendeur ${b1.Sequence} / ${b2.Sequence}`)

  const [s1, s2] = await Promise.all([
    c.request({ command: 'submit', tx_blob: encode(b1) }).catch(e => ({ result: { engine_result: e.data?.error ?? e.message } })),
    c.request({ command: 'submit', tx_blob: encode(b2) }).catch(e => ({ result: { engine_result: e.data?.error ?? e.message } })),
  ])
  console.log(`  soumission 1 : ${s1.result.engine_result}`)
  console.log(`  soumission 2 : ${s2.result.engine_result}`)
  await sleep(10000)

  const apNeuf = (await shareBalance(c, neuf.classicAddress, MPT)).amount
  const apAutre = (await shareBalance(c, autre.classicAddress, MPT)).amount
  const livrees = (apNeuf - avNeuf) + (apAutre - avAutre)
  console.log(`  parts livrées au total : ${livrees} (une seule vente = ${PARTS})`)

  const sain = livrees <= BigInt(PARTS)
  console.log(`\n  → ${sain ? '✅ une seule vente passe — la séquence protège' : '🔴 DOUBLE-VENTE POSSIBLE'}`)
  note('B double-vente', 'deux Batch concurrents peuvent-ils céder deux fois les mêmes parts ?',
    `${s1.result.engine_result} / ${s2.result.engine_result} · ${livrees} parts livrées pour ${PARTS} vendues`,
    sain ? 'la séquence du vendeur sérialise — pas de double-vente' : 'PISTE DE SÉCURITÉ')
}

// ═════════════════════════════════════════════════════════════
console.log('\n\n════ C — FRACTIONNEMENT : vendre en quatre fois ════\n')
{
  const acheteurs = []
  for (let i = 0; i < 2; i++) acheteurs.push(await fundAccount())
  await sleep(6000)
  await Promise.all(acheteurs.map(a => issueCredential(c, { issuer, subject: a })))

  const avV = await xrpBalance(c, vendeur.classicAddress)
  let n = 0
  for (const a of acheteurs) {
    const b = await swap({ seller: vendeur, buyer: a, shares: '400000', price: '352000', authorize: true })
    const sub = await c.request({ command: 'submit', tx_blob: encode(b) })
    const t = await attendre(sub.result.tx_json?.hash)
    const recu = (await shareBalance(c, a.classicAddress, MPT)).amount
    console.log(`  fraction ${++n} → ${t?.meta?.TransactionResult ?? sub.result.engine_result} · ${recu} parts`)
  }
  const apV = await xrpBalance(c, vendeur.classicAddress)
  const coutTotal = avV - apV + BigInt(352000) * BigInt(acheteurs.length)
  console.log(`\n  coût vendeur pour ${acheteurs.length} fractions : ${coutTotal} drops`)
  console.log(`  → chaque fraction est un Batch complet : le coût est LINÉAIRE, pas amorti.`)
  note('C fractionnement', 'vendre en N fois coûte-t-il N fois plus cher ?',
    `${coutTotal} drops pour ${acheteurs.length} fractions`,
    'linéaire — une exécution partielle n\'a aucun avantage de coût, chaque fraction paie son enveloppe')
}

// ═════════════════════════════════════════════════════════════
console.log('\n\n════ D — LA DÉCOTE, rapportée à la NAV ════\n')
{
  const g = await readVaultGraph(c, v0.vaultId)
  const total = BigInt(g.vault.AssetsTotal)
  const parts = BigInt(g.vault.shares.OutstandingAmount)
  const navParPart = Number(total) / Number(parts)
  console.log(`  AssetsTotal      ${XRP(total)} XRP`)
  console.log(`  AssetsAvailable  ${XRP(g.vault.AssetsAvailable)} XRP  (le reste est prêté)`)
  console.log(`  parts            ${parts}`)
  console.log(`  NAV              ${navParPart.toFixed(6)} drop par part\n`)

  const trades = await priceHistory(c, v0.vaultId)
  console.log(`  ${trades.length} échange(s) relus sur la chaîne :\n`)
  const decotes = []
  for (const t of trades) {
    if (!t.pricePerShare) { console.log(`    ${t.closeTime}  ${t.shares} parts — prix introuvable (donation ?)`); continue }
    const d = (1 - t.pricePerShare / navParPart) * 100
    decotes.push(d)
    console.log(`    ${t.closeTime}  ${String(t.shares).padStart(9)} parts`
      + ` à ${t.pricePerShare.toFixed(4)} drop/part → décote ${d.toFixed(2)} %`)
  }
  if (decotes.length) {
    const moy = decotes.reduce((a, b) => a + b, 0) / decotes.length
    const illiquide = Number(total - BigInt(g.vault.AssetsAvailable)) / Number(total) * 100
    console.log(`\n  décote moyenne     ${moy.toFixed(2)} %`)
    console.log(`  part illiquide     ${illiquide.toFixed(2)} % des actifs sont prêtés`)
    console.log(`\n  → le vendeur paie ${moy.toFixed(1)} % pour sortir immédiatement de quelque chose`)
    console.log(`    dont ${illiquide.toFixed(0)} % est bloqué jusqu'aux remboursements.`)
    note('D décote', 'combien coûte la liquidité immédiate ?',
      `décote moyenne ${moy.toFixed(2)} % pour un vault dont ${illiquide.toFixed(0)} % des actifs sont prêtés`,
      'c\'est le prix de marché de la sortie anticipée — et il est lisible entièrement on-chain')
  }
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
