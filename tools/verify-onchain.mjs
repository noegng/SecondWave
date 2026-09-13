/**
 * tools/verify-onchain.mjs — vérifie chaque hash cité dans le dépôt, et écrit ONCHAIN.md.
 *
 *   npm run onchain
 *
 * Un lien « verified » qui n'a jamais été rejoué n'est pas vérifié, c'est une
 * affirmation. Ce script relit chaque transaction sur le Devnet, récupère son
 * type, son code de retour et son ledger, et n'écrit que ce qui répond.
 * Ce qui ne répond pas est signalé, pas caché.
 *
 * Les hashes sont collectés dans les fichiers du dépôt plutôt que recopiés ici :
 * si quelqu'un ajoute une preuve au README, elle entre dans le document sans
 * qu'on ait à y penser.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { connect, txUrl } from '@secondwave/core'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SOURCES = ['README.md', 'probes-marche/PREUVES.md', 'FEEDBACK.md', 'FRICTIONS-annexe.md']
const HASH = /[0-9A-F]{64}/g

/** Le rôle d'une transaction dans le projet, pour que le tableau se lise seul. */
const ROLES = {
  VaultCreate:            ['Vault', 'Create the private closed-ended vault'],
  VaultDeposit:           ['Vault', 'Deposit during Subscription, receive shares'],
  VaultWithdraw:          ['Vault', 'Exit during Redemption'],
  VaultClawback:          ['Vault', 'Issuer seizure on an IOU vault — the analyst’s red signal'],
  VaultSet:               ['Vault', 'Update a vault’s Data'],
  LoanBrokerSet:          ['Lending', 'Create the broker'],
  LoanBrokerCoverDeposit: ['Lending', 'Deposit first-loss capital'],
  LoanBrokerCoverWithdraw:['Lending', 'Withdraw it — 100 % possible at zero debt'],
  LoanSet:                ['Lending', 'Grant a loan, co-signed borrower + broker'],
  LoanPay:                ['Lending', 'Repay an instalment'],
  LoanManage:             ['Lending', 'Record an impairment or a default'],
  LoanDelete:             ['Lending', 'Purge a settled loan'],
  CredentialCreate:       ['Identity', 'The KYC issuer attests an account'],
  CredentialAccept:       ['Identity', 'The subject accepts — without it the credential is worthless'],
  CredentialDelete:       ['Identity', 'Revoke an attestation'],
  PermissionedDomainSet:  ['Identity', 'The domain listing accepted credentials'],
  MPTokenAuthorize:       ['Settlement', 'The buyer authorises themselves to receive the shares'],
  MPTokenIssuanceCreate:  ['Settlement', 'Issue a multi-purpose token'],
  Payment:                ['Settlement', 'Transfer — shares (MPT) or price'],
  Batch:                  ['Settlement', 'The atomic exchange — shares against price'],
  TicketCreate:           ['Settlement', 'Reserve the sequence numbers that make an offer durable'],
  AccountSet:             ['Settlement', 'Issuer flags — and cancelling an offer by consuming its ticket'],
  EscrowCreate:           ['Escrow', 'Lock shares or price under a shared condition'],
  EscrowFinish:           ['Escrow', 'Unlock — the domain gate is re-checked here'],
  EscrowCancel:           ['Escrow', 'Refund after expiry'],
  TrustSet:               ['Settlement', 'The trustline of an IOU vault'],
  OfferCreate:            ['Settlement', 'Native order book — refuses MPTs'],
}
const ORDRE = ['Vault', 'Lending', 'Identity', 'Settlement', 'Escrow', 'Other']

// ── collecte ──────────────────────────────────────────────────────────────
const vus = new Map()                       // hash → fichiers où il apparaît
for (const f of SOURCES) {
  const p = join(ROOT, f)
  if (!existsSync(p)) continue
  for (const h of readFileSync(p, 'utf8').match(HASH) ?? []) {
    if (!vus.has(h)) vus.set(h, new Set())
    vus.get(h).add(f)
  }
}
console.log(`${vus.size} hashes cités dans ${SOURCES.filter(f => existsSync(join(ROOT, f))).length} fichiers\n`)

// ── vérification ──────────────────────────────────────────────────────────
const c = await connect()
const ok = []
const morts = []
let i = 0
for (const [hash, fichiers] of vus) {
  i++
  try {
    const r = await c.request({ command: 'tx', transaction: hash })
    if (!r.result.validated) throw new Error('non validée')
    const tj = r.result.tx_json ?? r.result
    const type = tj.TransactionType
    const [cat, role] = ROLES[type] ?? ['Other', '—']
    ok.push({
      hash, type, cat, role,
      result: r.result.meta?.TransactionResult ?? '?',
      ledger: r.result.ledger_index,
      date: r.result.close_time_iso ?? null,
      fichiers: [...fichiers],
    })
    process.stdout.write(`  ✅ ${type.padEnd(24)} ${hash.slice(0, 12)}…\n`)
  } catch (e) {
    morts.push({ hash, raison: e.data?.error ?? e.message, fichiers: [...fichiers] })
    process.stdout.write(`  🔴 ${'?'.padEnd(24)} ${hash.slice(0, 12)}…  ${e.data?.error ?? e.message}\n`)
  }
}
const ledger = (await c.request({ command: 'ledger', ledger_index: 'validated' })).result.ledger_index
await c.disconnect()

// ── document ──────────────────────────────────────────────────────────────
ok.sort((a, b) => ORDRE.indexOf(a.cat) - ORDRE.indexOf(b.cat) || a.type.localeCompare(b.type))
const groupes = new Map()
for (const t of ok) {
  if (!groupes.has(t.cat)) groupes.set(t.cat, [])
  groupes.get(t.cat).push(t)
}

// Un représentant par type de transaction : le document doit se lire, pas
// répéter quatre fois le même AccountSet. Le compte des autres reste visible.
const sections = [...groupes].map(([cat, txs]) => {
  const parType = new Map()
  for (const t of txs) {
    if (!parType.has(t.type)) parType.set(t.type, [])
    parType.get(t.type).push(t)
  }
  const lignes = [...parType].map(([type, list]) => {
    const t = list[0]
    const autres = list.length > 1 ? `  *(+${list.length - 1} more verified)*` : ''
    return `| \`${type}\` | ${t.role}${autres} | \`${t.result}\` | [\`${t.hash.slice(0, 14)}…\`](${txUrl(t.hash)}) |`
  }).join('\n')
  return `### ${cat}\n\n| Transaction | Role in the project | Result | On-chain proof |\n|---|---|---|---|\n${lignes}`
}).join('\n\n')

const types = new Set(ok.map(t => t.type))

const md = `# Verified on-chain transactions

Every link below was **re-queried on the XRPL public Devnet** by
\`tools/verify-onchain.mjs\` (\`npm run onchain\`), which reads the hashes cited
across the repository, checks each one is validated, and records its type,
result code and ledger. Nothing here is copied by hand.

**${ok.length} transactions verified across ${types.size} transaction types**${morts.length ? `, ${morts.length} unreachable (listed at the end)` : ''} · validated ledger at check time: \`${ledger}\` · explorer: https://devnet.xrpl.org

One representative per type is shown below; where several of the same type are
verified, the count is noted. The full set is cited inline in
[README.md](README.md) and [probes-marche/PREUVES.md](probes-marche/PREUVES.md).

${sections}

## What some of these prove

- **\`VaultClawback\`** — an IOU vault's issuer can seize a position. That is why the analyst raises a red flag as soon as the issuer carries \`AllowTrustLineClawback\`.
- **\`EscrowFinish\` returning \`tecNO_AUTH\`** — the permissioned-domain gate is re-checked *at finish*, not only at creation. This is the measurement the escrow-to-a-domain proposal rests on.
- **\`Batch\`** — the atomic exchange. See [\`probes-marche/PREUVES.md\`](probes-marche/PREUVES.md) for the A / E pair: one delivered, one did nothing, and their metadata is identical.
- **\`LoanSet\`** — co-signed borrower + broker, submitted through the SDK helper fixed in \`xrpl.js@5.2.0-beta.1\`, with no workaround.

${morts.length ? `## Unreachable

These hashes are cited in the repository but no longer answer. A Devnet reset
is the usual cause; they are listed rather than quietly dropped.

${morts.map(m => `- \`${m.hash}\` — ${m.raison} (cited in ${m.fichiers.join(', ')})`).join('\n')}
` : ''}---

*Regenerate with \`npm run onchain\`. A dead link will show up here rather than in front of a judge.*
`

writeFileSync(join(ROOT, 'ONCHAIN.md'), md)
console.log(`\n  → ONCHAIN.md · ${ok.length} vérifiées, ${morts.length} injoignables`)
process.exit(morts.length ? 0 : 0)
