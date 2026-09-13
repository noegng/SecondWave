/**
 * Build statique pour Vercel.
 *
 * Écrit dans `apps/web/out` — dossier **non** gitignoré. Deux pièges déjà
 * rencontrés :
 *   · `apps/web/dist` est masqué par `dist/` dans .gitignore → collecteur vide
 *   · écrire soi-même dans `.vercel/output` se fait écraser par `vercel build`
 *     quand `outputDirectory` est absent → encore 0 fichier, 404 DEPLOYMENT_NOT_FOUND
 */
import { cp, mkdir, rm, readdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('.', import.meta.url))
const REPO = join(ROOT, '..', '..')
const OUT = join(ROOT, 'out')

await rm(OUT, { recursive: true, force: true })
await mkdir(join(OUT, 'data'), { recursive: true })
await cp(join(ROOT, 'public'), OUT, { recursive: true })

for (const f of ['snapshot.json', 'world.json', 'orderbook.json']) {
  const src = join(REPO, f)
  if (existsSync(src)) await cp(src, join(OUT, 'data', f))
  else console.warn(`build: ${f} absent — l'onglet correspondant sera vide`)
}

async function countFiles(dir) {
  let n = 0
  for (const e of await readdir(dir, { withFileTypes: true })) {
    n += e.isDirectory() ? await countFiles(join(dir, e.name)) : 1
  }
  return n
}

const n = await countFiles(OUT)
if (!existsSync(join(OUT, 'index.html'))) throw new Error('build: index.html manquant dans apps/web/out')
if (n === 0) throw new Error('build: 0 fichier dans apps/web/out')
console.log(`SecondWave web → apps/web/out (${n} fichiers)`)
