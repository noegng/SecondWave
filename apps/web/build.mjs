/**
 * Build statique pour Vercel (Build Output API v3).
 *
 * On n'écrit PAS dans `apps/web/dist` : ce dossier est gitignoré (`dist/`),
 * et le collecteur Vercel le saute — déploiement « réussi » mais 0 fichier
 * → 404 DEPLOYMENT_NOT_FOUND.
 *
 * Cible officielle : `.vercel/output/static` + `config.json`.
 * N'utilise que des modules natifs Node.
 */
import { cp, mkdir, rm, writeFile, readdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('.', import.meta.url))
const REPO = join(ROOT, '..', '..')
const OUT = join(REPO, '.vercel', 'output')
const STATIC = join(OUT, 'static')

await rm(OUT, { recursive: true, force: true })
await mkdir(join(STATIC, 'data'), { recursive: true })
await cp(join(ROOT, 'public'), STATIC, { recursive: true })

for (const f of ['snapshot.json', 'world.json', 'orderbook.json']) {
  const src = join(REPO, f)
  if (existsSync(src)) await cp(src, join(STATIC, 'data', f))
  else console.warn(`build: ${f} absent — l'onglet correspondant sera vide`)
}

await writeFile(join(OUT, 'config.json'), JSON.stringify({
  version: 3,
  routes: [
    { src: '/data/(.*)', headers: { 'Cache-Control': 'no-store' }, continue: true },
    { handle: 'filesystem' },
  ],
}, null, 2))

async function countFiles(dir) {
  let n = 0
  for (const e of await readdir(dir, { withFileTypes: true })) {
    n += e.isDirectory() ? await countFiles(join(dir, e.name)) : 1
  }
  return n
}

const n = await countFiles(STATIC)
if (n === 0) throw new Error('build: 0 fichier dans .vercel/output/static')
console.log(`SecondWave web → .vercel/output/static (${n} fichiers)`)
