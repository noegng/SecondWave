/**
 * apps/web — serveur statique minimal pour l'interface SecondWave.
 *
 * Sert `public/` et expose les trois fichiers de données du dépôt
 * (`snapshot.json`, `world.json`, `orderbook.json`) sous `/data/…`.
 * `/api/holdings?account=` lit les MPToken de parts on-chain (Devnet).
 * Aucune dépendance, aucun build : `npm run web` puis http://localhost:8787
 */
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { join, extname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createApi, ApiError } from './api.mjs'

const ROOT = fileURLToPath(new URL('.', import.meta.url))
const REPO = join(ROOT, '..', '..')
const PUBLIC = join(ROOT, 'public')
const PORT = process.env.PORT ?? 8787
const ADDR_RE = /^r[1-9A-HJ-NP-Za-km-z]{24,34}$/

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
}

const DATA = new Set(['snapshot.json', 'world.json', 'orderbook.json'])

let xrpl = null
const api = createApi(REPO)

function json(res, code, body) {
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(JSON.stringify(body))
}

/** Corps JSON d'une requête, plafonné — c'est un serveur de démo, pas une passoire. */
function readBody(req, max = 1 << 20) {
  return new Promise((resolve, reject) => {
    let raw = ''
    req.on('data', chunk => {
      raw += chunk
      if (raw.length > max) { reject(new Error('corps trop volumineux')); req.destroy() }
    })
    req.on('end', () => {
      if (!raw) return resolve({})
      try { resolve(JSON.parse(raw)) } catch { reject(new Error('JSON invalide')) }
    })
    req.on('error', reject)
  })
}

async function holdingsFor(account) {
  const world = JSON.parse(await readFile(join(REPO, 'world.json'), 'utf8'))
  const { connect } = await import('@secondwave/core')
  if (!xrpl?.isConnected()) xrpl = await connect(world.network)

  let objects = []
  try {
    const r = await xrpl.request({
      command: 'account_objects', account, type: 'mptoken', ledger_index: 'validated',
    })
    objects = r.result.account_objects ?? []
  } catch (e) {
    if (e?.data?.error !== 'actNotFound') throw e
  }

  const byId = new Map(objects.map(o => [o.MPTokenIssuanceID, o]))
  const positions = (world.vaults ?? []).map(v => {
    const o = byId.get(v.shareMptId)
    return {
      key: v.key,
      vaultId: v.vaultId,
      mptId: v.shareMptId,
      shares: o?.MPTAmount ?? '0',
      holds: Boolean(o),
    }
  }).filter(p => p.holds && p.shares !== '0')

  return { account, source: 'devnet', positions }
}

createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost')
    // URL paths stay posix; path.normalize() on Windows turns them into `\api\…`
    // and the API / data routes never match.
    let path = url.pathname.replace(/\\/g, '/').replace(/^\/+/, '')
    if (path.includes('..')) { res.writeHead(403); return res.end() }

    // ── Le rail durable : publier, prendre, confirmer, annuler ──
    // 🔴 Ces routes SIGNENT avec les seeds de state.json (voir api.mjs).
    //    Serveur de démonstration : localhost seulement.
    if (path.startsWith('api/offers')) {
      const rest = path.slice('api/offers'.length).replace(/^\//, '')
      try {
        if (req.method === 'GET' && rest === '')
          return json(res, 200, await api.list({ account: url.searchParams.get('account') }))

        // Combien ce vendeur peut-il encore proposer sur ce vault ?
        if (req.method === 'GET' && rest === 'capacity')
          return json(res, 200, await api.capacity({
            seller: url.searchParams.get('seller'), vaultId: url.searchParams.get('vaultId'),
          }))

        if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })
        const body = await readBody(req)

        if (rest === '') return json(res, 200, await api.post(body))
        const [id, action] = rest.split('/')
        if (action === 'take') return json(res, 200, await api.take({ id, ...body }))
        if (action === 'confirm') return json(res, 200, await api.confirm({ id, ...body }))
        if (action === 'cancel') return json(res, 200, await api.cancel({ id, ...body }))
        if (action === 'unmatch') return json(res, 200, await api.unmatch({ id, ...body }))
        return json(res, 404, { error: 'unknown action' })
      } catch (e) {
        // Un refus métier (offre déjà prise, pas de seed…) n'est pas une panne :
        // 409 pour que l'interface l'affiche tel quel au lieu d'un « erreur serveur ».
        const code = e instanceof ApiError ? 409 : 500
        return json(res, code, { error: e.message, code: e.code ?? 'internal' })
      }
    }

    if (path === 'api/holdings') {
      const account = url.searchParams.get('account') ?? ''
      if (!ADDR_RE.test(account)) return json(res, 400, { error: 'invalid account' })
      try {
        return json(res, 200, await holdingsFor(account))
      } catch (e) {
        return json(res, 502, { error: e.message ?? 'ledger unreachable' })
      }
    }

    let file
    if (path.startsWith('data/')) {
      const name = path.slice(5)
      if (!DATA.has(name)) { res.writeHead(404); return res.end('not found') }
      file = join(REPO, name)
    } else {
      if (path === '' || path === '.') path = 'index.html'
      file = join(PUBLIC, path)
      if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end() }
    }

    const body = await readFile(file)
    res.writeHead(200, {
      'content-type': MIME[extname(file)] ?? 'application/octet-stream',
      'cache-control': 'no-store',
    })
    res.end(body)
  } catch {
    res.writeHead(404); res.end('not found')
  }
}).listen(PORT, () => {
  console.log(`SecondWave — interface sur http://localhost:${PORT}`)
})
