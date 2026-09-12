/**
 * fixtures/test-settlement.mjs — les trois cas de la couche de règlement.
 *
 *   node fixtures/test-settlement.mjs
 *
 * Tourne sur le monde généré par `npm run world`. Les trois cas sont ceux qui
 * décident si la couche sert à quelque chose :
 *
 *   1. acheteur éligible        → le swap passe, les soldes bougent
 *   2. acheteur non éligible    → le preflight bloque AVANT de dépenser un drop
 *   3. preflight court-circuité → le Batch renvoie tesSUCCESS, rien n'a bougé,
 *                                 et la réconciliation le dit quand même
 *
 * Le cas 3 est le plus important : c'est la démonstration que `tesSUCCESS` sur
 * un Batch ne veut rien dire.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { connect, Wallet, shareBalance } from '@secondwave/core'
import { SettlementEngine } from '@secondwave/settlement'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const world = JSON.parse(readFileSync(join(ROOT, 'world.json'), 'utf8'))
const seeds = JSON.parse(readFileSync(join(ROOT, 'state.json'), 'utf8'))

const v = world.vaults.find(x => x.key === 'sain')
const deposants = seeds.vaults.sain.depositors.map(sd => Wallet.fromSeed(sd))

// Le vendeur est le plus gros détenteur, l'acheteur un autre membre du domaine,
// l'intrus le compte qui n'a jamais reçu de credential.
const vendeur = deposants.find(w => w.classicAddress === v.holders[0].account)
const acheteur = deposants.find(w => w.classicAddress !== vendeur.classicAddress)
const intrus = Wallet.fromSeed(seeds.nonMember)

const c = await connect(world.network)
const e = new SettlementEngine(c)
let echecs = 0

const titre = t => console.log(`\n━━━ ${t} ━━━`)
const verdict = (attendu, obtenu) => {
  const ok = attendu === obtenu
  if (!ok) echecs++
  console.log(`  ${ok ? '✅' : '❌'} attendu « ${attendu} », obtenu « ${obtenu} »`)
}

// ── 1 ────────────────────────────────────────────────────────
titre('1. Acheteur éligible — le swap doit passer')
const parts = BigInt(v.holders[0].shares) / 4n
const prix = String(parts * 88n / 100n)          // décote de 12 % : c'est le prix de la liquidité
console.log(`  ${vendeur.classicAddress.slice(0, 10)}… cède ${parts} parts pour ${Number(prix) / 1e6} XRP`)

const r1 = await e.executeSwap({
  vaultId: v.vaultId, sellerWallet: vendeur, buyerWallet: acheteur,
  shares: parts.toString(), price: prix,
})
for (const ch of r1.preflight?.checks ?? [])
  console.log(`     ${ch.ok === true ? '✅' : ch.ok === false ? '⛔' : '❔'} ${ch.name} — ${ch.detail}`)
if (r1.evidence) {
  console.log(`  jambes reconstruites : ${r1.evidence.legs.length}`)
  for (const l of r1.evidence.legs) console.log(`     ${l.result}  ${l.type}`)
}
console.log(`  déplacé : ${r1.moved?.shares ?? '—'} parts`)
verdict('done', r1.stage)

// ── 2 ────────────────────────────────────────────────────────
titre('2. Acheteur non éligible — le preflight doit bloquer')
const r2 = await e.executeSwap({
  vaultId: v.vaultId, sellerWallet: vendeur, buyerWallet: intrus,
  shares: '1000000', price: '900000',
})
for (const b of r2.blockers ?? []) console.log(`     ⛔ ${b}`)
verdict('preflight', r2.stage)

// ── 3 ────────────────────────────────────────────────────────
titre('3. Preflight court-circuité — le Batch va mentir')
const mptId = (await e.vault(v.vaultId)).ShareMPTID
const avant = await shareBalance(c, intrus.classicAddress, mptId)
const r3 = await e.executeSwap({
  vaultId: v.vaultId, sellerWallet: vendeur, buyerWallet: intrus,
  shares: '1000000', price: '900000', skipPreflight: true,
})
console.log(`  résultat annoncé par le Batch : ${r3.batchResult ?? r3.engineResult ?? '—'}`)
console.log(`  parts réellement reçues       : ${r3.moved?.received ?? avant.amount}`)
if (r3.warning) console.log(`  ⚠️  ${r3.warning}`)
verdict('silent-failure', r3.stage)

console.log(`\n${echecs === 0 ? '✅ les trois cas passent.' : `❌ ${echecs} cas en échec.`}\n`)
await c.disconnect()
process.exit(echecs === 0 ? 0 : 1)
