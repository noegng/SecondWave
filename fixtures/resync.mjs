/**
 * Recolle world.json + snapshot.json sur le Devnet à partir de state.json.
 *
 * Cas typique : `git pull` a ramené un world.json d'un autre monde, alors que
 * le state.json local (gitignoré) pointe encore sur les vrais comptes.
 *
 *   node fixtures/resync.mjs
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Wallet } from 'xrpl'
import { connect, readVaultGraph, holderMap, rippleNow } from '@secondwave/core'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const jsonBig = (o) => JSON.stringify(o, (_, v) => (typeof v === 'bigint' ? v.toString() : v), 2)

const LABELS = {
  sain: 'Vault sain — garantie normale, un prêt qui paie, un prêt qu\'on laisse filer',
  predateur: 'Vault prédateur — broker 0/0 (aucun first-loss) + AUTO-PRÊT du propriétaire, jamais remboursé',
  deprecie: 'Vault déprécié — un prêt impairé, un prêt impairé puis réhabilité',
  iou: 'Vault IOU — actif émis par un tiers qui a AllowTrustLineClawback (position saisissable)',
  verrouille: 'Vault à parts NON transférables — aucun marché secondaire possible',
  redemption: 'Vault déjà en phase Redemption — la sortie normale des déposants est testable',
  solde: 'Vault avec un prêt soldé puis supprimé (LoanDelete) — fin de vie propre',
}

if (!existsSync(join(ROOT, 'state.json'))) {
  console.error('state.json absent — rien à recoller.')
  process.exit(1)
}

const seeds = JSON.parse(readFileSync(join(ROOT, 'state.json'), 'utf8'))
const issuer = Wallet.fromSeed(seeds.issuer)
const nonMember = Wallet.fromSeed(seeds.nonMember)
const c = await connect()

async function objects(account) {
  try {
    const r = await c.request({ command: 'account_objects', account, ledger_index: 'validated' })
    return r.result.account_objects ?? []
  } catch {
    return []
  }
}

const issuerObjs = await objects(issuer.classicAddress)
const domain = issuerObjs.find(o => o.LedgerEntryType === 'PermissionedDomain')
const domainId = domain?.index ?? domain?.DomainID ?? null

const known = new Set([
  issuer.classicAddress,
  nonMember.classicAddress,
  ...Object.values(seeds.vaults).flatMap(s => [
    Wallet.fromSeed(s.owner).classicAddress,
    ...s.depositors.map(d => Wallet.fromSeed(d).classicAddress),
    ...s.borrowers.map(b => Wallet.fromSeed(b).classicAddress),
  ]),
])

const world = {
  generatedAt: new Date().toISOString(),
  resyncedFrom: 'state.json + ledger',
  network: 'wss://s.devnet.rippletest.net:51233',
  issuer: issuer.classicAddress,
  domainId,
  nonMember: nonMember.classicAddress,
  vaults: [],
}

const snapshot = {
  generatedAt: world.generatedAt,
  capturedAtRipple: String(rippleNow()),
  note: 'Dump recollé depuis le ledger (fixtures/resync.mjs).',
  vaults: {},
}

const guests = new Set()

/**
 * ⚠️ `clawbackArmed` ne se devine pas : c'est un drapeau du compte ÉMETTEUR
 *    (lsfAllowTrustLineClawback). Le laisser à false effaçait le signal rouge
 *    du vault IOU — l'analyste perdait « position saisissable », et trois
 *    tests de non-régression tombaient.
 */
const LSF_ALLOW_CLAWBACK = 0x80000000
const armeCache = new Map()
async function clawbackArme(issuer) {
  if (!issuer) return false
  if (armeCache.has(issuer)) return armeCache.get(issuer)
  let arme = false
  try {
    const r = await c.request({ command: 'account_info', account: issuer, ledger_index: 'validated' })
    arme = Boolean(Number(r.result.account_data.Flags ?? 0) & LSF_ALLOW_CLAWBACK)
  } catch { /* compte introuvable : on n'affirme rien */ }
  armeCache.set(issuer, arme)
  return arme
}

for (const [key, s] of Object.entries(seeds.vaults)) {
  const owner = Wallet.fromSeed(s.owner)
  const vaultObj = (await objects(owner.classicAddress)).find(o => o.LedgerEntryType === 'Vault')
  if (!vaultObj) {
    console.error(`pas de Vault pour ${key} (${owner.classicAddress})`)
    continue
  }
  const vaultId = vaultObj.VaultID ?? vaultObj.index
  const g = await readVaultGraph(c, vaultId)
  const h = await holderMap(c, g.vault)
  const isIou = Boolean(g.vault.Asset?.issuer)
  const entry = {
    key,
    label: LABELS[key] ?? key,
    vaultId,
    pseudoAccount: g.vault.Account,
    owner: owner.classicAddress,
    shareMptId: g.vault.ShareMPTID,
    asset: isIou ? 'IOU' : 'XRP',
    assetIssuer: isIou ? g.vault.Asset.issuer : null,
    clawbackArmed: isIou ? await clawbackArme(g.vault.Asset.issuer) : false,
    subscriptionDate: Number(g.vault.SubscriptionDate ?? 0),
    redemptionDate: Number(g.vault.RedemptionDate ?? 0),
  }
  for (const holder of h.holders) {
    if (!known.has(holder.account)) guests.add(holder.account)
  }
  world.vaults.push({
    ...entry,
    holders: h.holders.map(x => ({ account: x.account, shares: x.shares.toString() })),
    brokers: g.brokers.map(b => ({ brokerId: b.LoanBrokerID ?? b.index })),
    loans: g.brokers.flatMap(b => (b.loans ?? []).map(l => ({
      loanId: l.LoanID ?? l.index,
      borrower: l.Borrower,
    }))),
  })
  snapshot.vaults[key] = { meta: entry, graph: g, holders: h }
  console.log(`  ${key}  ${vaultId.slice(0, 8)}…  ${h.count} détenteur(s)  phase ${g.phase}`)
}

if (guests.size === 1) world.guest = [...guests][0]
if (guests.size) world.guests = [...guests]

writeFileSync(join(ROOT, 'world.json'), jsonBig(world))
writeFileSync(join(ROOT, 'snapshot.json'), jsonBig(snapshot))
const webData = join(ROOT, 'apps', 'web', 'public', 'data')
mkdirSync(webData, { recursive: true })
writeFileSync(join(webData, 'world.json'), jsonBig(world))
writeFileSync(join(webData, 'snapshot.json'), jsonBig(snapshot))

await c.disconnect()
console.log(`\nworld.json recollé sur ${issuer.classicAddress}  (${world.vaults.length} vaults)`)
if (world.guests?.length) console.log(`invités on-chain : ${world.guests.join(', ')}`)
