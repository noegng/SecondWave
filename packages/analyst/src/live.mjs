/**
 * Lecture live Devnet : nos vaults (world.json) et les vaults publics.
 *
 * Il n'existe pas de `vaults` RPC. On a deux chemins :
 *   1. un `vault_id` connu → vault_info → account_objects (brokers) → loans
 *   2. `ledger_data { type: "vault" }` pour découvrir les autres
 */
import { connect, holderMap, readVaultGraph, rippleNow } from '@secondwave/core'

const VAULT_ID_RE = /^[0-9A-Fa-f]{64}$/

export function isVaultId(value) {
  return typeof value === 'string' && VAULT_ID_RE.test(value)
}

export async function withClient(fn, url) {
  const client = await connect(url)
  try {
    return await fn(client)
  } finally {
    await client.disconnect()
  }
}

export async function fetchVaultLive(client, vaultId) {
  const graph = await readVaultGraph(client, vaultId)
  const holders = await holderMap(client, graph.vault)
  return { graph, holders, nowRipple: rippleNow() }
}

/**
 * Parcourt le ledger à la recherche d'objets Vault.
 * rippled peut renvoyer des pages vides tant que le curseur n'a pas
 * atteint un Vault — on continue tant qu'il y a un marker.
 */
export async function scanPublicVaults(client, { maxPages = 60, exclude = new Set() } = {}) {
  const found = []
  let marker
  let pages = 0
  let emptyPages = 0

  for (; pages < maxPages; pages++) {
    const req = {
      command: 'ledger_data',
      ledger_index: 'validated',
      type: 'vault',
      limit: 256,
    }
    if (marker) req.marker = marker

    let r
    try {
      r = await client.request(req)
    } catch (e) {
      return {
        found,
        pages,
        error: e.data?.error ?? e.message,
        hint: 'ledger_data type=vault refuse ou indisponible sur ce serveur',
      }
    }

    const state = r.result.state ?? []
    if (!state.length) emptyPages++
    for (const obj of state) {
      if (obj.LedgerEntryType && obj.LedgerEntryType !== 'Vault') continue
      const vaultId = obj.index
      if (!vaultId) continue
      found.push({
        vaultId,
        owner: obj.Owner ?? null,
        assetsTotal: obj.AssetsTotal ?? '0',
        vaultKind: obj.VaultKind ?? null,
        ours: exclude.has(vaultId.toUpperCase()) || exclude.has(vaultId),
      })
    }

    marker = r.result.marker
    if (!marker) break
  }

  return { found, pages, emptyPages, truncated: Boolean(marker) }
}
