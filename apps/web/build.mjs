/**
 * Build statique pour Vercel : assemble `apps/web/dist/`.
 *
 * Copie `public/` (l'app) puis les trois fichiers de données du dépôt sous
 * `dist/data/`, là où l'interface les lit (`/data/snapshot.json`, …).
 * N'utilise que des modules natifs Node — aucune dépendance à installer.
 */
import { cp, mkdir, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('.', import.meta.url))
const REPO = join(ROOT, '..', '..')
const DIST = join(ROOT, 'dist')

await rm(DIST, { recursive: true, force: true })
await mkdir(join(DIST, 'data'), { recursive: true })
await cp(join(ROOT, 'public'), DIST, { recursive: true })

for (const f of ['snapshot.json', 'world.json', 'orderbook.json']) {
  const src = join(REPO, f)
  if (existsSync(src)) await cp(src, join(DIST, 'data', f))
  else console.warn(`build: ${f} absent — l'onglet correspondant sera vide`)
}

console.log('SecondWave web → apps/web/dist')
