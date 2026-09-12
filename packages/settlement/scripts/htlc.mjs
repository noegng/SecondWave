/**
 * Rail « htlc » sur la chaîne — le chemin nominal et le remboursement.
 *
 *   node packages/settlement/scripts/htlc.mjs        (~3 minutes)
 *
 * A. NOMINAL   les quatre étapes, vers un acheteur qui n'a JAMAIS touché ce
 *              MPT : `EscrowFinish` crée son objet `MPToken` tout seul — le
 *              rail HTLC n'a pas de jambe d'autorisation.
 *              L'acheteur ne reçoit rien du vendeur : il RELIT le secret
 *              on-chain dans la transaction de l'étape 3.
 * B. REFUND    une offre que personne n'accepte : les parts sont débitées dès
 *              la création, et `EscrowCancel` les rend intégralement après
 *              `CancelAfter`.
 *
 * 🔴 Ce script ne construit jamais d'escrow sans `CancelAfter` : un tel escrow,
 *    si le destinataire perd son credential, est irrécupérable à jamais.
 */
import { SettlementEngine, htlc, planTimings, verifyCondition } from '@secondwave/settlement'
import {
  connect, scene, nouveauMembre, XRP, titre, montrer, sleep, rippleNow,
  shareBalance, xrpBalance,
} from './_decor.mjs'

const c = await connect()
const e = new SettlementEngine(c)
const s = await scene(c, 'sain')
let echecs = 0
const verdict = (cond, quoi, detail = '') => {
  if (!cond) echecs++
  console.log(`  ${cond ? '✅' : '❌'} ${quoi}${detail ? ' — ' + detail : ''}`)
}

console.log(`vault   ${s.key} · ${s.mptId.slice(0, 16)}…`)
console.log(`vendeur ${s.seller.classicAddress} · ${s.sellerShares} parts`)

// ═══════════════════════════════════════════════════════════════
titre('A · CHEMIN NOMINAL — 4 étapes vers un acheteur VIERGE de ce MPT')

const acheteur = await nouveauMembre(c, s.seller, '6000000')
await sleep(3000)
const avantMpt = await shareBalance(c, acheteur.classicAddress, s.mptId)
console.log(`  acheteur neuf ${acheteur.classicAddress}`)
console.log(`    objet MPToken avant l'échange : ${avantMpt.holds ? 'présent' : 'ABSENT — aucune autorisation préalable'}\n`)

const t = planTimings({ now: rippleNow(), ttl: 600 })
console.log(`  échéances calculées :`)
console.log(`    parts (vendeur)  CancelAfter ${t.sharesCancelAfter}  (T+${t.ttl}s)`)
console.log(`    prix  (acheteur) CancelAfter ${t.priceCancelAfter}  (T+${t.ttl - t.margin}s)`)
console.log(`    marge ${t.margin}s — le prix expire EN PREMIER, sinon le vendeur encaisse`)
console.log(`    à la dernière seconde et l'acheteur ne peut plus prendre les parts.\n`)

const r = await e.settle({
  rail: 'htlc', vaultId: s.vaultId,
  sellerWallet: s.seller, buyerWallet: acheteur,
  shares: '500000', price: '440000', ttl: 600,
})

for (const ch of r.preflight?.checks ?? [])
  console.log(`    ${ch.ok === true ? '✅' : ch.ok === false ? '⛔' : '❔'} ${ch.name} — ${ch.detail}`)
console.log()
for (const st of r.evidence?.steps ?? [])
  console.log(`    ${st.ok ? '✅' : '❌'} ${st.step.padEnd(8)} ${st.result}  ${st.url ?? ''}`)
console.log()
montrer('avant', r.before)
montrer('après', r.after)
console.log(`\n  condition     ${r.evidence?.condition}`)
console.log(`  secret        ${r.evidence?.secretSource} — l'acheteur n'a rien reçu du vendeur`)
console.log(`  déplacé       ${r.moved?.shares} parts · payé ${XRP(r.moved?.paid ?? 0)} XRP (prix + frais)`)
console.log(`  coût          ${r.cost?.fees} drops sur ${r.cost?.txCount} transactions`)
console.log(`  réserve       ${r.cost?.reserveLocked} drops bloqués pendant l'échange, rendus au dénouement`)

const apresMpt = await shareBalance(c, acheteur.classicAddress, s.mptId)
verdict(r.stage === 'done', 'les 4 étapes passent et la réconciliation est bonne', r.stage)
verdict(!avantMpt.holds && apresMpt.holds, 'EscrowFinish a CRÉÉ l\'objet MPToken de l\'acheteur',
  'aucune jambe MPTokenAuthorize n\'a été envoyée')
verdict(r.evidence?.secretSource === 'relu on-chain', 'le secret a été relu dans la transaction de claim')

// ═══════════════════════════════════════════════════════════════
titre('B · REFUND — une offre que personne n\'accepte')

const CANCEL_DANS = 100
const avant = (await shareBalance(c, s.seller.classicAddress, s.mptId)).amount
const p = await htlc.propose(c, {
  sellerWallet: s.seller, buyer: acheteur.classicAddress, mptId: s.mptId,
  shares: '300000', cancelAfter: rippleNow() + CANCEL_DANS,
})
const pendant = (await shareBalance(c, s.seller.classicAddress, s.mptId)).amount
console.log(`  propose       ${p.result} · ${p.url ?? ''}`)
console.log(`  parts du vendeur : ${avant} → ${pendant} (${avant - pendant} bloquées DÈS la création)`)
verdict(avant - pendant === 300_000n, 'les parts sont débitées à la création de l\'escrow')

// Personne n'accepte. On attend l'échéance, puis on annule.
const attente = p.sharesCancelAfter - rippleNow() + 12
console.log(`\n  personne n'accepte — attente de ${attente}s jusqu'à CancelAfter…`)
await sleep(attente * 1000)

const encore = await e.htlc.stillOpen({ owner: p.owner, offerSequence: p.offerSequence })
console.log(`  escrow au ledger avant annulation : ${encore.open ? 'oui' : 'non'}`)

// ⚠️ Le solde est mesuré JUSTE avant et JUSTE après l'annulation : les comptes
//    du monde de démo sont partagés, d'autres sessions y échangent des parts
//    pendant l'attente. Seul le delta autour de cette transaction est à nous.
const justeAvant = (await shareBalance(c, s.seller.classicAddress, s.mptId)).amount
const x = await e.htlc.refund({ wallet: s.seller, escrow: p })
const apres = (await shareBalance(c, s.seller.classicAddress, s.mptId)).amount
const parti = await e.htlc.stillOpen({ owner: p.owner, offerSequence: p.offerSequence })

console.log(`  refund        ${x.result} · ${x.url ?? ''}`)
console.log(`  parts du vendeur : ${justeAvant} → ${apres} (delta ${apres - justeAvant})`)
console.log(`  escrow au ledger après : ${parti.open ? 'encore là' : 'supprimé (' + parti.reason + ')'}`)
verdict(apres - justeAvant === 300_000n, 'les parts bloquées sont rendues INTÉGRALEMENT',
  `+${apres - justeAvant} rendues sur 300000 bloquées`)
verdict(!parti.open, 'l\'objet Escrow a disparu du ledger')

console.log(`\n${echecs === 0 ? '✅ rail htlc : nominal et remboursement conformes.' : `❌ ${echecs} écart(s).`}\n`)
await c.disconnect()
process.exit(echecs === 0 ? 0 : 1)
