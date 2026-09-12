/**
 * probes-marche/04 — le gate du domaine tient-il au DÉNOUEMENT d'un escrow ?
 *
 *   node probes-marche/04-escrow-gate-au-denouement.mjs
 *
 * La sonde 03 a montré qu'un EscrowCreate vers un non-membre rend tecNO_AUTH :
 * le contrôle de credential a lieu à la CRÉATION. Reste la question qui décide
 * si l'escrow peut entrer dans le produit :
 *
 *   A. Si le credential de l'acheteur est RÉVOQUÉ entre la création et le
 *      dénouement, EscrowFinish livre-t-il quand même ?
 *      → si oui, l'escrow est un contournement du gate : piste de sécurité.
 *
 *   B. Un acheteur qui n'a jamais fait MPTokenAuthorize peut-il recevoir par
 *      escrow ? (le Payment l'exige — l'escrow aussi ?)
 *
 *   C. EscrowCancel rend-il les parts au vendeur ?
 *      → sans ça, une offre expirée immobilise le capital pour de bon.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import {
  connect, Wallet, fundAccount, submit, readVault, shareBalance,
  isDomainMember, sleep, rippleNow, txUrl,
} from '@secondwave/core'
import { issueCredential, hex } from '@secondwave/vault'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const world = JSON.parse(readFileSync(join(ROOT, 'world.json'), 'utf8'))
const seeds = JSON.parse(readFileSync(join(ROOT, 'state.json'), 'utf8'))

const resultats = []
const note = (cas, question, reponse, verdict) => resultats.push({ cas, question, reponse, verdict })

const v0 = world.vaults.find(x => x.key === 'sain')
const issuer = Wallet.fromSeed(seeds.issuer)
const deposants = seeds.vaults.sain.depositors.map(s => Wallet.fromSeed(s))

const c = await connect(world.network)
const vault = await readVault(c, v0.vaultId)
const MPT = vault.ShareMPTID
const DOMAIN = vault.shares?.DomainID ?? world.domainId
const parts = v => ({ mpt_issuance_id: MPT, value: String(v) })

const soldes = []
for (const w of deposants) soldes.push([w, (await shareBalance(c, w.classicAddress, MPT)).amount])
soldes.sort((a, b) => (b[1] > a[1] ? 1 : -1))
const vendeur = soldes[0][0]
console.log(`vendeur ${vendeur.classicAddress} · ${soldes[0][1]} parts`)
console.log(`domaine ${DOMAIN}\n`)

/** La séquence de la transaction qui a créé un escrow — c'est son identifiant. */
const seqDe = r => r.raw?.result?.tx_json?.Sequence ?? r.raw?.result?.Sequence

// ═════════════════════════════════════════════════════════════
console.log('════ A — CREDENTIAL RÉVOQUÉ ENTRE LA CRÉATION ET LE DÉNOUEMENT ════\n')
{
  const acheteur = await fundAccount()
  await sleep(6000)
  console.log(`  acheteur ${acheteur.classicAddress}`)

  const cr = await issueCredential(c, { issuer, subject: acheteur })
  console.log(`  credential émis et accepté : ${cr.result}`)
  console.log(`  éligible ? ${JSON.stringify(await isDomainMember(c, acheteur.classicAddress, DOMAIN))}`)

  const auth = await submit(c, {
    TransactionType: 'MPTokenAuthorize', Account: acheteur.classicAddress, MPTokenIssuanceID: MPT,
  }, acheteur)
  console.log(`  MPTokenAuthorize : ${auth.result}`)

  const finishAfter = rippleNow() + 25
  const esc = await submit(c, {
    TransactionType: 'EscrowCreate', Account: vendeur.classicAddress,
    Destination: acheteur.classicAddress, Amount: parts('300000'),
    FinishAfter: finishAfter, CancelAfter: rippleNow() + 900,
  }, vendeur)
  console.log(`  EscrowCreate 300 000 parts : ${esc.result} (Sequence ${seqDe(esc)})`)
  if (!esc.ok) { note('A', 'escrow créé ?', esc.result, 'test impossible'); }

  // ⚡ la révocation, pendant que les parts dorment dans l'escrow
  const rev = await submit(c, {
    TransactionType: 'CredentialDelete', Account: issuer.classicAddress,
    Subject: acheteur.classicAddress, Issuer: issuer.classicAddress, CredentialType: hex('KYC'),
  }, issuer)
  console.log(`\n  ⚡ CredentialDelete par l'émetteur : ${rev.result}`)
  const apres = await isDomainMember(c, acheteur.classicAddress, DOMAIN)
  console.log(`  éligible après révocation ? ${JSON.stringify(apres)}`)

  const attente = finishAfter - rippleNow() + 6
  if (attente > 0) { console.log(`  attente de ${attente}s avant EscrowFinish…`); await sleep(attente * 1000) }

  const avant = (await shareBalance(c, acheteur.classicAddress, MPT)).amount
  const fin = await submit(c, {
    TransactionType: 'EscrowFinish', Account: acheteur.classicAddress,
    Owner: vendeur.classicAddress, OfferSequence: seqDe(esc),
  }, acheteur)
  const apresParts = (await shareBalance(c, acheteur.classicAddress, MPT)).amount
  console.log(`  EscrowFinish : ${fin.result}${fin.message ? ' — ' + fin.message : ''}`)
  console.log(`  parts livrées à un compte DEVENU INÉLIGIBLE : ${apresParts - avant}`)

  const livre = apresParts - avant > 0n
  console.log(`\n  → ${livre ? '🔴 L\'ESCROW CONTOURNE LE GATE — le contrôle n\'a lieu qu\'à la création'
                            : '✅ le gate tient aussi au dénouement'}`)
  note('A', 'un escrow livre-t-il à un acheteur dont le credential a été révoqué ?',
    `révocation ${rev.result} · éligible: ${apres.member} · EscrowFinish ${fin.result} · ${apresParts - avant} parts livrées`,
    livre ? 'PISTE DE SÉCURITÉ — à remonter à un mentor avant le pitch'
          : 'le gate est évalué au dénouement — l\'escrow est sûr pour un vault privé')
  if (fin.hash) console.log(`  ${txUrl(fin.hash)}`)
}

// ═════════════════════════════════════════════════════════════
console.log('\n\n════ B — DÉNOUEMENT SANS MPTokenAuthorize PRÉALABLE ════\n')
{
  const acheteur = await fundAccount()
  await sleep(6000)
  const cr = await issueCredential(c, { issuer, subject: acheteur })
  console.log(`  acheteur ${acheteur.classicAddress} · credential ${cr.result}`)
  console.log(`  (aucun MPTokenAuthorize — c'est tout l'objet du test)`)

  const finishAfter = rippleNow() + 25
  const esc = await submit(c, {
    TransactionType: 'EscrowCreate', Account: vendeur.classicAddress,
    Destination: acheteur.classicAddress, Amount: parts('200000'),
    FinishAfter: finishAfter, CancelAfter: rippleNow() + 900,
  }, vendeur)
  console.log(`  EscrowCreate : ${esc.result}${esc.message ? ' — ' + esc.message : ''}`)

  if (esc.ok) {
    const attente = finishAfter - rippleNow() + 6
    if (attente > 0) { console.log(`  attente de ${attente}s…`); await sleep(attente * 1000) }
    const fin = await submit(c, {
      TransactionType: 'EscrowFinish', Account: acheteur.classicAddress,
      Owner: vendeur.classicAddress, OfferSequence: seqDe(esc),
    }, acheteur)
    const recu = (await shareBalance(c, acheteur.classicAddress, MPT)).amount
    console.log(`  EscrowFinish : ${fin.result}${fin.message ? ' — ' + fin.message : ''}`)
    console.log(`  parts reçues : ${recu}`)
    note('B', 'un escrow peut-il livrer à un compte sans MPTokenAuthorize préalable ?',
      `EscrowCreate ${esc.result} · EscrowFinish ${fin.result} · ${recu} parts`,
      recu > 0n ? '⭐ l\'escrow crée le MPToken tout seul — une jambe de moins que le Batch'
                : 'l\'autorisation reste un prérequis, comme pour un Payment')
  } else {
    note('B', 'un escrow peut-il viser un compte sans MPTokenAuthorize préalable ?',
      esc.result, 'refusé dès la création')
  }
}

// ═════════════════════════════════════════════════════════════
console.log('\n\n════ C — ESCROWCANCEL : les parts reviennent-elles ? ════\n')
{
  const acheteur = await fundAccount()
  await sleep(6000)
  await issueCredential(c, { issuer, subject: acheteur })

  const cancelAfter = rippleNow() + 45
  const avantV = (await shareBalance(c, vendeur.classicAddress, MPT)).amount
  const esc = await submit(c, {
    TransactionType: 'EscrowCreate', Account: vendeur.classicAddress,
    Destination: acheteur.classicAddress, Amount: parts('150000'),
    FinishAfter: rippleNow() + 30, CancelAfter: cancelAfter,
  }, vendeur)
  const pendantV = (await shareBalance(c, vendeur.classicAddress, MPT)).amount
  console.log(`  EscrowCreate : ${esc.result}`)
  console.log(`  parts du vendeur : ${avantV} → ${pendantV}  (bloquées : ${avantV - pendantV})`)

  const attente = cancelAfter - rippleNow() + 8
  if (attente > 0) { console.log(`  attente de ${attente}s avant EscrowCancel…`); await sleep(attente * 1000) }

  const can = await submit(c, {
    TransactionType: 'EscrowCancel', Account: vendeur.classicAddress,
    Owner: vendeur.classicAddress, OfferSequence: seqDe(esc),
  }, vendeur)
  const apresV = (await shareBalance(c, vendeur.classicAddress, MPT)).amount
  console.log(`  EscrowCancel : ${can.result}${can.message ? ' — ' + can.message : ''}`)
  console.log(`  parts du vendeur après annulation : ${apresV}  (rendues : ${apresV - pendantV})`)

  const rendues = apresV - pendantV
  console.log(`\n  → ${rendues > 0n ? '✅ les parts reviennent — une offre expirée ne piège pas le capital'
                                    : '🔴 les parts ne reviennent pas'}`)
  note('C', 'EscrowCancel rend-il les parts au vendeur ?',
    `${can.result} · ${rendues} parts rendues sur ${avantV - pendantV} bloquées`,
    rendues > 0n ? 'une offre on-chain expirée se dénoue proprement'
                 : 'PROBLÈME — le capital reste piégé')
}

// ═════════════════════════════════════════════════════════════
console.log('\n\n════════════════════ RÉCAPITULATIF ════════════════════\n')
for (const r of resultats) {
  console.log(`  [${r.cas}]`)
  console.log(`    Q : ${r.question}`)
  console.log(`    R : ${r.reponse}`)
  console.log(`    → ${r.verdict}\n`)
}
await c.disconnect()
