// H96 (bis) — subscribe sur le pseudo-compte, cette fois avec un dépôt qui RÉUSSIT
// (le premier essai a échoué en tecEXPIRED : une tx en échec n'affecte pas le
//  pseudo-compte, donc aucun événement n'était attendu — contre-essai propre).
import fs from 'node:fs'
import { connect, submit, Wallet, sleep } from '@secondwave/core'

const smoke = JSON.parse(fs.readFileSync(new URL('./state-smoke.json', import.meta.url), 'utf8'))
const c = await connect()
const LL = Wallet.fromSeed(smoke.wallets.longlived.seed)
const vault = (await c.request({ command: 'vault_info', vault_id: smoke.vaultId })).result.vault

const events = []
await c.request({ command: 'subscribe', accounts: [vault.Account] })
c.on('transaction', t => events.push({
  type: t.tx_json?.TransactionType ?? t.transaction?.TransactionType,
  validated: t.validated, result: t.meta?.TransactionResult ?? t.engine_result,
}))

const r = await submit(c, {
  TransactionType: 'VaultDeposit', Account: LL.classicAddress, VaultID: smoke.vaultId, Amount: '2000000',
}, LL)
console.log('dépôt (open-ended):', r.result)
await sleep(8000)
console.log('événements reçus sur le pseudo-compte:', JSON.stringify(events))
await c.disconnect()
