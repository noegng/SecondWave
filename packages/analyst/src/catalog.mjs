/**
 * Catalogue world.json + snapshot.json : mêmes champs que `meta` du snapshot
 * (clawbackArmed, asset, key…). Le CLI Hugo n'envoie que { graph, holders }.
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

let cache = null

function readJson(name) {
  const path = join(ROOT, name)
  if (!existsSync(path)) return null
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

function indexByVaultId() {
  if (cache) return cache
  const byId = new Map()

  const world = readJson('world.json')
  for (const v of world?.vaults ?? []) {
    if (!v?.vaultId) continue
    byId.set(v.vaultId.toUpperCase(), {
      key: v.key,
      label: v.label,
      vaultId: v.vaultId,
      asset: v.asset,
      assetIssuer: v.assetIssuer ?? null,
      clawbackArmed: Boolean(v.clawbackArmed),
      ours: true,
    })
  }

  const snapshot = readJson('snapshot.json')
  for (const row of Object.values(snapshot?.vaults ?? {})) {
    const meta = row?.meta
    if (!meta?.vaultId) continue
    const id = meta.vaultId.toUpperCase()
    const prev = byId.get(id) ?? {}
    byId.set(id, {
      ...prev,
      ...meta,
      clawbackArmed: Boolean(meta.clawbackArmed || prev.clawbackArmed),
      ours: true,
    })
  }

  cache = byId
  return cache
}

/** Invalide le cache (tests). */
export function resetCatalog() {
  cache = null
}

export function lookupVaultMeta(vaultId) {
  if (!vaultId) return null
  return indexByVaultId().get(String(vaultId).toUpperCase()) ?? null
}

/** Spread sans les clés à `undefined`, qui écraseraient le catalogue. */
const defini = (o) => Object.fromEntries(Object.entries(o ?? {}).filter(([, v]) => v !== undefined))

export function resolveMeta(graph, meta) {
  const vaultId = graph?.vaultId ?? graph?.vault?.index ?? meta?.vaultId
  const fromCatalog = lookupVaultMeta(vaultId)
  return {
    ours: false,          // hors catalogue = inconnu, pas « à nous »
    ...fromCatalog,
    ...defini(meta),
    vaultId: vaultId ?? meta?.vaultId ?? fromCatalog?.vaultId,
  }
}
