import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { analyse } from '../src/analyse.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const snapshot = JSON.parse(readFileSync(join(ROOT, 'snapshot.json'), 'utf8'))
const expected = JSON.parse(readFileSync(join(ROOT, 'packages/analyst/EXPECTED.json'), 'utf8'))

describe('analyse() vs EXPECTED.json', () => {
  for (const [key, want] of Object.entries(expected.vaults)) {
    it(`${key} : signaux rouges stables`, () => {
      const row = snapshot.vaults[key]
      assert.ok(row, `snapshot sans vault ${key}`)
      const note = analyse({ graph: row.graph, holders: row.holders, meta: row.meta })
      for (const flag of want.redFlags) {
        assert.ok(note.codes.red.includes(flag), `${key} devrait avoir le rouge ${flag} (vus : ${note.codes.red.join(',')})`)
      }
      for (const flag of want.alerts ?? []) {
        assert.ok(
          note.codes.alerts.includes(flag) || note.codes.red.includes(flag),
          `${key} devrait avoir l'alerte ${flag} (vues : ${note.codes.alerts.join(',')})`,
        )
      }
      if (want.fairPrice === null) assert.equal(note.fairPrice, null)
      assert.equal(typeof note.score, 'number')
      assert.equal(note.verdict, want.verdict)
    })
  }
})
