/**
 * Runner analyste.
 *
 *   npm run analyse                         liste snapshot + world
 *   npm run analyse -- predateur            snapshot figé (hors ligne)
 *   npm run analyse -- all                  les 7 vaults du snapshot
 *   npm run analyse -- live                 relit world.json sur le Devnet
 *   npm run analyse -- live predateur
 *   npm run analyse -- vault <id>           un vault public (ou le nôtre) par id
 *   npm run analyse -- scan                 découvre les Vault du ledger
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { analyse } from './analyse.mjs'
import { fetchVaultLive, isVaultId, scanPublicVaults, withClient } from './live.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const COULEUR = { sain: '🟢', prudence: '🟡', risqué: '🟠', 'à fuir': '🔴' }
const PUCE = { info: '·', alerte: '⚠️ ', rouge: '🔴' }

function loadJson(name) {
  const path = join(ROOT, name)
  if (!existsSync(path)) return null
  return JSON.parse(readFileSync(path, 'utf8'))
}

function parseArgs(argv) {
  const out = { live: false, scan: false, all: false, vaultId: null, key: null }
  const rest = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    // npm Windows avale --live comme config : on accepte aussi les sous-commandes nues.
    if (a === '--live' || a === 'live') out.live = true
    else if (a === '--scan' || a === 'scan') out.scan = true
    else if (a === '--all' || a === 'all') out.all = true
    else if (a === '--vault' || a === 'vault') out.vaultId = argv[++i]
    else if (a.startsWith('--vault=')) out.vaultId = a.slice('--vault='.length)
    else rest.push(a)
  }
  if (rest[0] && isVaultId(rest[0])) out.vaultId = rest[0]
  else if (rest[0] && rest[0] !== 'all') out.key = rest[0]
  return out
}

function worldIndex(world) {
  const byKey = new Map()
  const ids = new Set()
  for (const v of world?.vaults ?? []) {
    byKey.set(v.key, v)
    if (v.vaultId) ids.add(v.vaultId.toUpperCase())
  }
  return { byKey, ids }
}

function printFacts({ key, label, source, graph, holders, meta }) {
  const m = graph.metrics ?? {}
  console.log(`\n════ ${key} ════ ${label}`)
  console.log(`source ${source}\n`)
  console.log('FAITS DÉRIVÉS (core.readVaultGraph + holderMap) :')
  console.log(`  phase           ${m.phase ?? '(open-ended)'}${m.secondsRemaining != null ? ` (reste ${m.secondsRemaining}s)` : ''}`)
  console.log(`  actif           ${meta?.asset ?? (m.isIou ? 'IOU' : 'XRP')}${m.isIou ? ` émis par ${m.assetIssuer}` : ''}${meta?.clawbackArmed ? '  🔴 clawback armé' : ''}`)
  console.log(`  NAV/part        ${m.navPerShare}  (prudente ${m.navPrudentPerShare})`)
  console.log(`  utilisation     ${m.utilisation ?? 0}   perte latente ${m.lossRatio ?? 0}`)
  console.log(`  parts non transf. ${m.shareNonTransferable}`)
  console.log(`  détenteurs      ${holders.count}  concentration ${holders.concentration}  HHI ${holders.hhi}`)
  console.log(`  résumé          brokers=${m.brokerCount} prêts=${m.loanCount}`
    + ` sansCover=${m.hasUncoveredBroker} autoPrêt=${m.hasSelfLoan} défautNonDéclaré=${m.hasUndeclaredDefault}`)
  for (const b of graph.brokers ?? []) {
    const bm = b.metrics
    console.log(`  broker ${(bm.owner ?? '?').slice(0, 10)}…  cover ${bm.coverAvailable} (retirable ${bm.coverWithdrawable}${bm.coverWithdrawableIsEstimate ? '~' : ''})`
      + ` dette ${bm.debtTotal}  taux ${bm.coverRateMinimumPct}%/${bm.coverRateLiquidationPct}%${bm.noCover ? '  🔴 0/0' : ''}`)
    for (const l of b.loans ?? []) {
      const lm = l.metrics
      console.log(`     prêt ${lm.borrower?.slice(0, 10)}…  ${lm.status}`
        + `${lm.selfLoan ? ' 🔴 AUTO-PRÊT' : ''}${lm.defaillable ? ` (défaillable, +${lm.secondsLate}s)` : ''}`
        + `  poids ${lm.weight ?? 0}`)
    }
  }
}

function printNote(note) {
  console.log(`\nNOTE ANALYSTE :`)
  console.log(`  ${COULEUR[note.verdict] ?? '·'} ${note.verdict} (${note.score}/100)`
    + `  NAV ${note.nav}  fairPrice ${note.fairPrice ?? 'null'}`)
  if (!note.signaux.length) console.log('  aucun signal')
  for (const s of note.signaux) console.log(`  ${PUCE[s.niveau] ?? '·'} ${s.titre} — ${s.detail}`)
  for (const sc of note.brokerNotes ?? []) {
    console.log(`  broker note ${sc.rating} (${sc.riskScore})  FLCR ${sc.components.flcr}  NPL ${sc.components.npl}`)
  }
  console.log()
}

function reportVault({ key, label, source, graph, holders, meta }) {
  printFacts({ key, label, source, graph, holders, meta })
  const note = analyse({ graph, holders, meta })
  printNote(note)
  return note
}

function usage(snapshot, world) {
  console.log('Vaults du snapshot (hors ligne) :')
  if (snapshot) {
    for (const [k, v] of Object.entries(snapshot.vaults)) {
      console.log(`  ${k.padEnd(12)} — ${v.meta.label}`)
    }
  } else {
    console.log('  (snapshot.json absent)')
  }
  if (world) {
    console.log('\nVaults de world.json (ids on-chain) :')
    for (const v of world.vaults) {
      console.log(`  ${v.key.padEnd(12)} ${v.vaultId}`)
    }
  }
  console.log(`
Usage :
  npm run analyse -- <clé>           snapshot hors ligne
  npm run analyse -- all
  npm run analyse -- live            relit world.json sur le Devnet
  npm run analyse -- live <clé>
  npm run analyse -- vault <id>      vault public par vault_id
  npm run analyse -- scan            découvre les Vault du ledger
`)
}

async function runLiveKeys(world, keys) {
  const { byKey } = worldIndex(world)
  await withClient(async (client) => {
    for (const key of keys) {
      const v = byKey.get(key)
      if (!v) {
        console.error(`clé « ${key} » absente de world.json`)
        continue
      }
      try {
        const live = await fetchVaultLive(client, v.vaultId)
        reportVault({
          key,
          label: v.label,
          source: `live Devnet ${v.vaultId}`,
          graph: live.graph,
          holders: live.holders,
          meta: { ...v, ours: true },
        })
      } catch (e) {
        console.error(`\n⛔ ${key} (${v.vaultId.slice(0, 10)}…) — ${e.data?.error_message ?? e.message}\n`)
      }
    }
  })
}

async function runPublicVault(vaultId, ours) {
  await withClient(async (client) => {
    const live = await fetchVaultLive(client, vaultId)
    reportVault({
      key: ours ? 'nôtre' : 'public',
      label: ours ? 'vault SecondWave' : 'vault public (hors world.json)',
      source: `live Devnet ${vaultId}`,
      graph: live.graph,
      holders: live.holders,
      meta: { ours: Boolean(ours), asset: live.graph.metrics?.isIou ? 'IOU' : 'XRP' },
    })
  })
}

async function runScan(world) {
  const { ids } = worldIndex(world)
  console.log('Scan ledger_data type=vault (Devnet)…')
  const result = await withClient((client) => scanPublicVaults(client, { exclude: ids }))
  if (result.error) {
    console.error(`scan interrompu : ${result.error}`)
    if (result.hint) console.error(result.hint)
  }
  console.log(`pages ${result.pages}  vides ${result.emptyPages ?? 0}  vaults ${result.found.length}${result.truncated ? '  (tronqué)' : ''}`)
  const ours = result.found.filter((v) => v.ours)
  const pub = result.found.filter((v) => !v.ours)
  const preview = (list) => {
    for (const v of list.slice(0, 8)) {
      console.log(`  ${v.vaultId}  owner ${v.owner}  assets ${v.assetsTotal}  kind ${v.vaultKind ?? '-'}`)
    }
    if (list.length > 8) console.log(`  … +${list.length - 8}`)
  }
  if (ours.length) {
    console.log(`\nNôtres dans la fenêtre (${ours.length}) :`)
    preview(ours)
  }
  if (!pub.length) {
    console.log('\nAucun vault public trouvé dans la fenêtre scannée.')
    console.log('Pour en analyser un : npm run analyse -- vault <vault_id>')
    return
  }
  const closed = pub.filter((v) => Number(v.vaultKind) === 1)
  const funded = pub.filter((v) => Number(v.assetsTotal) > 0)
  console.log(`\nPublics ${pub.length}  ·  funded ${funded.length}  ·  closed-ended ${closed.length}`)
  preview(pub)

  const sample = (closed.length ? closed : funded.length ? funded : pub).slice(0, 3)
  console.log(`\nAnalyse des ${sample.length} premiers publics :`)
  await withClient(async (client) => {
    for (const v of sample) {
      try {
        const live = await fetchVaultLive(client, v.vaultId)
        reportVault({
          key: 'public',
          label: `owner ${v.owner}`,
          source: `live Devnet ${v.vaultId}`,
          graph: live.graph,
          holders: live.holders,
          meta: { ours: false, asset: live.graph.metrics?.isIou ? 'IOU' : 'XRP' },
        })
      } catch (e) {
        console.error(`⛔ ${v.vaultId.slice(0, 10)}… — ${e.data?.error_message ?? e.message}`)
      }
    }
  })
}

const args = parseArgs(process.argv.slice(2))
const snapshot = loadJson('snapshot.json')
const world = loadJson('world.json')

if (args.scan) {
  await runScan(world)
} else if (args.vaultId) {
  if (!isVaultId(args.vaultId)) {
    console.error(`vault_id invalide : ${args.vaultId}`)
    process.exit(1)
  }
  const ours = worldIndex(world).ids.has(args.vaultId.toUpperCase())
  await runPublicVault(args.vaultId, ours)
} else if (args.live) {
  if (!world) {
    console.error('world.json introuvable — lancer `npm run world` (Devnet + faucet).')
    process.exit(1)
  }
  const keys = args.key ? [args.key] : [...worldIndex(world).byKey.keys()]
  await runLiveKeys(world, keys)
} else if (!args.key && !args.all) {
  usage(snapshot, world)
} else {
  if (!snapshot) {
    console.error('snapshot.json introuvable — lancer `npm run world` ou `npm run analyse -- --live`.')
    process.exit(1)
  }
  const keys = args.all ? Object.keys(snapshot.vaults) : [args.key]
  for (const key of keys) {
    const row = snapshot.vaults[key]
    if (!row) {
      console.error(`vault « ${key} » inconnu. Disponibles : ${Object.keys(snapshot.vaults).join(', ')}`)
      process.exit(1)
    }
    reportVault({
      key,
      label: row.meta.label,
      source: `snapshot figé à Ripple-time ${snapshot.capturedAtRipple}`,
      graph: row.graph,
      holders: row.holders,
      meta: row.meta,
    })
  }
}
