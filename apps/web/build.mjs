/**
 * Prépare le site statique.
 *
 * Source servie par Vercel : `apps/web/public` (fichiers du dépôt, pas un
 * dossier généré gitignoré). On y copie snapshot/world, puis on recopie
 * vers `dist` / `out` / `public` racine — le dashboard a déjà forcé
 * `apps/web/dist` et ignoré `vercel.json`.
 */
import { cp, mkdir, rm, readdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const WEB = fileURLToPath(new URL('.', import.meta.url))
const REPO = join(WEB, '..', '..')
const PUBLIC = join(WEB, 'public')
const DATA = join(PUBLIC, 'data')

await mkdir(DATA, { recursive: true })
for (const f of ['snapshot.json', 'world.json', 'orderbook.json']) {
  const src = join(REPO, f)
  if (existsSync(src)) await cp(src, join(DATA, f))
  else console.warn(`build: ${f} absent — l'onglet correspondant sera vide`)
}

async function countFiles(dir) {
  let n = 0
  for (const e of await readdir(dir, { withFileTypes: true })) {
    n += e.isDirectory() ? await countFiles(join(dir, e.name)) : 1
  }
  return n
}

async function mirror(dest) {
  if (dest === PUBLIC) return
  await rm(dest, { recursive: true, force: true })
  await mkdir(dest, { recursive: true })
  await cp(PUBLIC, dest, { recursive: true })
}

await mirror(join(WEB, 'dist'))
await mirror(join(WEB, 'out'))
try {
  await mirror(join(REPO, 'public'))
} catch {
  // Root Directory = apps/web : écriture hors projet ignorée
}

if (!existsSync(join(PUBLIC, 'index.html'))) {
  throw new Error('build: index.html manquant dans apps/web/public')
}
const n = await countFiles(PUBLIC)
if (n === 0) throw new Error('build: 0 fichier dans apps/web/public')
console.log(`SecondWave web → apps/web/public (${n} fichiers)`)
