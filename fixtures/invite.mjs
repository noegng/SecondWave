/**
 * Émet un credential KYC vers un wallet externe (l'extension l'accepte).
 *
 *   npm run invite -- rXXXXXXXX
 *
 * Ne dépose rien : hors Subscription, VaultDeposit est tecTOO_SOON.
 * Sert à pouvoir RECEVOIR des parts (achat / transfert) sur le monde actuel.
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client, Wallet } from 'xrpl'
import { connect } from '@secondwave/core'
import { createCredential } from '@secondwave/vault'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const ADDR_RE = /^r[1-9A-HJ-NP-Za-km-z]{24,34}$/
const subject = process.argv.slice(2).find((a) => ADDR_RE.test(a))

if (!subject) {
  console.error('\nusage : npm run invite -- rAdresseDevnet\n')
  process.exit(1)
}
if (!existsSync(join(ROOT, 'world.json')) || !existsSync(join(ROOT, 'state.json'))) {
  console.error('\nworld.json / state.json absents — `npm run world` d\'abord.\n')
  process.exit(1)
}

const world = JSON.parse(readFileSync(join(ROOT, 'world.json'), 'utf8'))
const seeds = JSON.parse(readFileSync(join(ROOT, 'state.json'), 'utf8'))
const issuer = Wallet.fromSeed(seeds.issuer)
const c = await connect(world.network)

try {
  await c.request({ command: 'account_info', account: subject, ledger_index: 'validated' })
} catch {
  console.error(`\n${subject} n'existe pas sur le Devnet.`)
  console.error('Faucet : https://faucet.devnet.rippletest.net/accounts\n')
  await c.disconnect()
  process.exit(1)
}

const cred = await createCredential(c, { issuer, subject })
await c.disconnect()

if (!cred.ok) {
  console.error(`\nCredentialCreate : ${cred.result} ${cred.message ?? ''}\n`)
  process.exit(1)
}

const sain = world.vaults.find((v) => v.key === 'sain')
console.log(`\nKYC émis par ${issuer.classicAddress} → ${subject}`)
console.log(`accepte-le dans l'extension (réseau Devnet), puis :`)
console.log(`  · dépôt : seulement si le vault est encore en Subscription`)
console.log(`  · réception de parts : possible tant que le vault est transférable`)
if (sain) {
  console.log(`\nvault sain : ${sain.vaultId}`)
  console.log(`https://devnet.xrpl.org/vaults/${sain.vaultId}\n`)
}
