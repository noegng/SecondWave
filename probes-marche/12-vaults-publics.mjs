/**
 * Y a-t-il de la matière dans les vaults publics du Devnet ?
 *
 * Le scan (`npm run analyse -- scan`) trouve des centaines de Vault qui ne sont
 * pas à nous. Reste à savoir s'ils ont des brokers, des prêts, plusieurs
 * détenteurs — sinon l'analyste n'a rien à dire dessus et le scan ne vaut pas
 * le temps de scène.
 */
import { connect, readVaultGraph, holderMap } from '@secondwave/core'
import { scanPublicVaults } from '../packages/analyst/src/live.mjs'

const t0 = Date.now()
const secondes = () => ((Date.now() - t0) / 1000).toFixed(1)

const client = await connect()
const scan = await scanPublicVaults(client, { maxPages: 60 })
console.log(`scan : ${scan.found.length} vaults, ${scan.pages} pages, ${secondes()} s`)

const candidats = scan.found
  .filter(v => Number(v.assetsTotal) > 0)
  .sort((a, b) => Number(b.assetsTotal) - Number(a.assetsTotal))
  .slice(0, 40)

console.log(`\nInspection des ${candidats.length} plus gros (assets décroissants) :`)
const interessants = []
for (const v of candidats) {
  try {
    const g = await readVaultGraph(client, v.vaultId)
    const h = await holderMap(client, g.vault)
    const prets = (g.brokers ?? []).reduce((s, b) => s + (b.loans?.length ?? 0), 0)
    const m = g.metrics ?? {}
    const ligne = `${v.vaultId}  owner ${v.owner.slice(0, 10)}…  assets ${v.assetsTotal}`
      + `  kind ${v.vaultKind ?? '-'}  phase ${m.phase ?? 'open'}  brokers ${g.brokers?.length ?? 0}`
      + `  prêts ${prets}  détenteurs ${h.count}`
      + `  défautNonDéclaré ${m.hasUndeclaredDefault}  autoPrêt ${m.hasSelfLoan}`
    console.log('  ' + ligne)
    if (prets > 0 || h.count > 1) interessants.push(ligne)
  } catch (e) {
    console.log(`  ${v.vaultId.slice(0, 12)}… ⛔ ${e.data?.error_message ?? e.message}`)
  }
}

console.log(`\nAvec prêts ou plusieurs détenteurs : ${interessants.length}`)
for (const l of interessants) console.log('  ' + l)
console.log(`\ntotal ${secondes()} s`)
await client.disconnect()
