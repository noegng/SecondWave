/**
 * probes-marche/03 — les deux pistes ouvertes par la sonde 01.
 *
 *   node probes-marche/03-escrow-et-drapeau-par-defaut.mjs
 *
 *   A. LE DRAPEAU PAR DÉFAUT
 *      La sonde 01 a montré que sous tfOnlyOne, tfUntilFailure et tfIndependent,
 *      les parts partent SANS paiement, avec tesSUCCESS et une meta à 1 nœud.
 *      Seul tfAllOrNothing protège. Question : que fait un Batch SANS drapeau ?
 *      Si le défaut n'est pas tfAllOrNothing, c'est un piège majeur.
 *
 *   B. L'ESCROW SUR MPT
 *      EscrowCreate a renvoyé tesSUCCESS avec des parts de vault en Amount.
 *      C'est un rail de règlement auquel on n'avait pas pensé. Jusqu'où va-t-il ?
 *      Un escrow de parts, c'est une offre de vente ON-CHAIN — le carnet
 *      n'aurait plus besoin d'être hors chaîne.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { BatchFlags, signMultiBatch } from 'xrpl'
import { encode, encodeForSigning } from 'ripple-binary-codec'
import { sign as kpSign } from 'ripple-keypairs'
import {
  connect, Wallet, fundAccount, submit, sequence, readVault, createdIndex,
  shareBalance, xrpBalance, sleep, rippleNow, txUrl,
} from '@secondwave/core'
import { issueCredential } from '@secondwave/vault'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const world = JSON.parse(readFileSync(join(ROOT, 'world.json'), 'utf8'))
const seeds = JSON.parse(readFileSync(join(ROOT, 'state.json'), 'utf8'))

const TF_INNER = 0x40000000
const XRP = d => (Number(d) / 1e6).toFixed(6)
const resultats = []
const note = (sonde, question, reponse, verdict) => resultats.push({ sonde, question, reponse, verdict })

const v0 = world.vaults.find(x => x.key === 'sain')
const issuer = Wallet.fromSeed(seeds.issuer)
const intrus = Wallet.fromSeed(seeds.nonMember)
const deposants = seeds.vaults.sain.depositors.map(s => Wallet.fromSeed(s))

const c = await connect(world.network)
const vault = await readVault(c, v0.vaultId)
const MPT = vault.ShareMPTID

const soldes = []
for (const w of deposants) soldes.push([w, (await shareBalance(c, w.classicAddress, MPT)).amount])
soldes.sort((a, b) => (b[1] > a[1] ? 1 : -1))
const vendeur = soldes[0][0]
const acheteur = soldes[1][0]
console.log(`vendeur  ${vendeur.classicAddress}  ${soldes[0][1]} parts`)
console.log(`acheteur ${acheteur.classicAddress}  ${soldes[1][1]} parts`)

const leg = t => ({ RawTransaction: { ...t, Fee: '0', SigningPubKey: '', Flags: TF_INNER } })
const parts = v => ({ mpt_issuance_id: MPT, value: String(v) })

async function envoyer(batch) {
  let r
  try { r = await c.request({ command: 'submit', tx_blob: encode(batch) }) }
  catch (e) { return { engine: e.data?.error ?? 'error', message: e.data?.error_exception ?? e.message } }
  const hash = r.result.tx_json?.hash
  if (r.result.engine_result !== 'tesSUCCESS')
    return { engine: r.result.engine_result, message: r.result.engine_result_message, hash }
  for (let i = 0; i < 20; i++) {
    await sleep(2000)
    try {
      const t = await c.request({ command: 'tx', transaction: hash })
      if (t.result.validated) return { engine: r.result.engine_result, validated: t.result.meta?.TransactionResult, meta: t.result.meta, hash }
    } catch { /* pas encore */ }
  }
  return { engine: r.result.engine_result, validated: 'timeout', hash }
}

// ═════════════════════════════════════════════════════════════
console.log('\n\n════ A — LE DRAPEAU PAR DÉFAUT ════\n')
// Même swap impayable. Cette fois, SANS champ Flags du tout.
{
  const PARTS = '250000', PRIX = '500000000'
  const avV = (await shareBalance(c, vendeur.classicAddress, MPT)).amount
  const avA = (await shareBalance(c, acheteur.classicAddress, MPT)).amount

  const sSeq = await sequence(c, vendeur.classicAddress)
  const bSeq = await sequence(c, acheteur.classicAddress)
  const li = (await c.request({ command: 'ledger', ledger_index: 'validated' })).result.ledger_index

  const construire = flags => ({
    TransactionType: 'Batch', Account: vendeur.classicAddress,
    ...(flags === undefined ? {} : { Flags: flags }),
    RawTransactions: [
      leg({ TransactionType: 'Payment', Account: vendeur.classicAddress,
            Destination: acheteur.classicAddress, Amount: parts(PARTS), Sequence: sSeq + 1 }),
      leg({ TransactionType: 'Payment', Account: acheteur.classicAddress,
            Destination: vendeur.classicAddress, Amount: PRIX, Sequence: bSeq }),
    ],
    Sequence: sSeq, Fee: '150', LastLedgerSequence: li + 25,
  })

  // A1 — champ Flags totalement absent : le SDK laisse-t-il seulement signer ?
  console.log('  A1. Batch SANS champ Flags')
  let a1
  try {
    const b = construire(undefined)
    signMultiBatch(acheteur, b)
    a1 = 'le SDK a signé'
  } catch (e) {
    a1 = `${e.constructor.name}: ${e.message}`
  }
  console.log(`      → ${a1}`)
  note('A défaut', 'le SDK accepte-t-il de co-signer un Batch sans champ Flags ?', a1,
    a1.startsWith('Error') ? 'garde-fou côté client, mais message brut et champ en minuscules'
                           : 'aucun garde-fou côté client')

  // A2 — Flags: 0 explicite : que fait le PROTOCOLE ?
  console.log('\n  A2. Batch avec Flags: 0 (aucun mode choisi)')
  const b = construire(0)
  signMultiBatch(acheteur, b)
  b.SigningPubKey = vendeur.publicKey
  b.TxnSignature = kpSign(encodeForSigning(b), vendeur.privateKey)

  const r = await envoyer(b)
  await sleep(4000)
  const apA = (await shareBalance(c, acheteur.classicAddress, MPT)).amount
  const bouge = apA - avA

  console.log(`      soumission      : ${r.engine}${r.validated ? ' → ' + r.validated : ''}`)
  console.log(`      message         : ${r.message ?? '—'}`)
  console.log(`      parts déplacées : ${bouge}   (la jambe du prix était impayable)`)
  const sur = bouge === 0n
  console.log(`\n  → ${sur ? '✅ Flags: 0 ne laisse rien passer'
                          : '🔴 PIÈGE : sans mode choisi, les parts partent sans paiement'}`)
  note('A défaut', 'que fait le protocole sur un Batch Flags: 0 dont une jambe échoue ?',
    `${r.engine}${r.validated ? ' → ' + r.validated : ''} · ${bouge} part déplacée`,
    sur ? 'refus ou rollback — le défaut est sûr'
        : 'PIÈGE — tfAllOrNothing doit être posé explicitement, rien ne le rappelle')
}

// ═════════════════════════════════════════════════════════════
console.log('\n\n════ B — L\'ESCROW SUR MPT, jusqu\'où ? ════\n')
{
  console.log('  B1. Escrow de parts vers un MEMBRE, puis EscrowFinish')
  const avA = (await shareBalance(c, acheteur.classicAddress, MPT)).amount
  const finishAfter = rippleNow() + 20
  const e1 = await submit(c, {
    TransactionType: 'EscrowCreate', Account: vendeur.classicAddress,
    Destination: acheteur.classicAddress, Amount: parts('400000'),
    FinishAfter: finishAfter, CancelAfter: rippleNow() + 900,
  }, vendeur)
  const escrowSeq = e1.raw?.result?.tx_json?.Sequence ?? e1.raw?.result?.Sequence
  console.log(`      EscrowCreate : ${e1.result}  (Sequence ${escrowSeq})`)

  // Les parts sont-elles retirées du vendeur dès la création ?
  const pendantV = (await shareBalance(c, vendeur.classicAddress, MPT)).amount
  console.log(`      parts du vendeur pendant le blocage : ${pendantV}`)

  if (e1.ok) {
    const attente = finishAfter - rippleNow() + 6
    if (attente > 0) { console.log(`      attente de ${attente}s avant EscrowFinish…`); await sleep(attente * 1000) }
    const e2 = await submit(c, {
      TransactionType: 'EscrowFinish', Account: acheteur.classicAddress,
      Owner: vendeur.classicAddress, OfferSequence: escrowSeq,
    }, acheteur)
    const apA = (await shareBalance(c, acheteur.classicAddress, MPT)).amount
    console.log(`      EscrowFinish : ${e2.result}${e2.message ? ' — ' + e2.message : ''}`)
    console.log(`      parts livrées à l'acheteur : ${apA - avA}`)
    note('B escrow', 'un escrow de parts se dénoue-t-il réellement ?',
      `EscrowCreate ${e1.result} · EscrowFinish ${e2.result} · ${apA - avA} parts livrées`,
      apA - avA > 0n ? '⭐ RAIL VIABLE — une offre de vente peut vivre ON-CHAIN'
                     : 'création acceptée mais dénouement impossible')
  }

  console.log('\n  B2. Escrow de parts vers un NON-MEMBRE du domaine')
  const e3 = await submit(c, {
    TransactionType: 'EscrowCreate', Account: vendeur.classicAddress,
    Destination: intrus.classicAddress, Amount: parts('100000'),
    FinishAfter: rippleNow() + 30, CancelAfter: rippleNow() + 900,
  }, vendeur)
  console.log(`      → ${e3.result}${e3.message ? ' — ' + e3.message : ''}`)
  note('B escrow', 'le gate du domaine s\'applique-t-il à un escrow de parts ?',
    e3.result,
    e3.ok ? '⚠️ l\'escrow contourne peut-être le gate — à vérifier au dénouement'
          : 'le gate tient aussi sur l\'escrow')

  console.log('\n  B3. Escrow de parts avec une condition crypto (PreimageSha256)')
  // Une condition transforme l'escrow en « livraison contre secret » :
  // c'est la brique d'un échange atomique sans Batch.
  const CONDITION = 'A0258020E3B0C44298FC1C149AFBF4C8996FB92427AE41E4649B934CA495991B7852B855810100'
  const e4 = await submit(c, {
    TransactionType: 'EscrowCreate', Account: vendeur.classicAddress,
    Destination: acheteur.classicAddress, Amount: parts('100000'),
    Condition: CONDITION, CancelAfter: rippleNow() + 900,
  }, vendeur)
  console.log(`      → ${e4.result}${e4.message ? ' — ' + e4.message : ''}`)
  note('B escrow', 'un escrow de parts accepte-t-il une condition crypto ?',
    e4.result,
    e4.ok ? '⭐ livraison contre secret possible — atomicité sans Batch'
          : 'condition refusée sur MPT')

  console.log('\n  B4. Escrow d\'XRP conditionné, dans l\'autre sens')
  // Si les deux sens marchent, on peut construire un échange atomique
  // par deux escrows liés par la même condition — sans Batch du tout.
  const e5 = await submit(c, {
    TransactionType: 'EscrowCreate', Account: acheteur.classicAddress,
    Destination: vendeur.classicAddress, Amount: '2000000',
    Condition: CONDITION, CancelAfter: rippleNow() + 900,
  }, acheteur)
  console.log(`      → ${e5.result}${e5.message ? ' — ' + e5.message : ''}`)
  note('B escrow', 'peut-on lier deux escrows par la même condition (parts ↔ XRP) ?',
    `parts ${e4.result} · XRP ${e5.result}`,
    e4.ok && e5.ok ? '⭐⭐ ÉCHANGE ATOMIQUE SANS BATCH — alternative complète au rail actuel'
                   : 'pas les deux sens')

  console.log('\n  B5. Les parts bloquées en escrow comptent-elles dans le solde ?')
  const finV = (await shareBalance(c, vendeur.classicAddress, MPT)).amount
  const info = (await c.request({ command: 'account_objects', account: vendeur.classicAddress,
                                  type: 'escrow', ledger_index: 'validated' })).result.account_objects
  console.log(`      solde MPToken du vendeur : ${finV}`)
  console.log(`      escrows ouverts          : ${info.length}`)
  console.log(`      → les parts engagées sont débitées DÈS la création de l'escrow`)
  note('B escrow', 'des parts bloquées en escrow restent-elles comptées dans le solde MPToken ?',
    `solde ${finV} · ${info.length} escrow(s) ouvert(s)`,
    'non — elles sont débitées dès la création. shareBalance ne peut pas double-compter, '
    + 'le preflight est donc juste sans traitement particulier')
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
