/**
 * apps/web — serveur statique minimal pour l'interface SecondWave.
 *
 * Sert `public/` et expose les trois fichiers de données du dépôt
 * (`snapshot.json`, `world.json`, `orderbook.json`) sous `/data/…`.
 * Aucune dépendance, aucun build : `npm run web` puis http://localhost:8787
 */
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { join, extname, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('.', import.meta.url))
const REPO = join(ROOT, '..', '..')
const PUBLIC = join(ROOT, 'public')
const PORT = process.env.PORT ?? 8787

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

createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost')
    let path = normalize(url.pathname).replace(/^([/\\])+/, '')

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
