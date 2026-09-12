import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { buildVaultGraph } from '@secondwave/core'
import { analyse, verdictFrom } from '../src/analyse.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const snapshot = JSON.parse(readFileSync(join(ROOT, 'snapshot.json'), 'utf8'))
const expected = JSON.parse(readFileSync(join(ROOT, 'packages/analyst/EXPECTED.json'), 'utf8'))

/**
 * On recalcule les `metrics` depuis les objets ledger bruts du snapshot : les
 * valeurs enregistrées datent de la capture et dériveraient en silence à chaque
 * changement de formule dans core.
 */
const graphDe = (row) => buildVaultGraph({
  vaultId: row.graph.vaultId,
  vault: row.graph.vault,
  brokers: row.graph.brokers,
  at: Number(row.graph.at),
})

describe('analyse() vs EXPECTED.json', () => {
  for (const [key, want] of Object.entries(expected.vaults)) {
    it(`${key} : signaux rouges stables`, () => {
      const row = snapshot.vaults[key]
      assert.ok(row, `snapshot sans vault ${key}`)
      const note = analyse({ graph: graphDe(row), holders: row.holders, meta: row.meta })
      // Égalité exacte des deux côtés : une alerte de trop est un bug de signal,
      // pas un détail — la version « au moins ceux-là » laissait passer du bruit.
      assert.deepEqual([...note.codes.red].sort(), [...want.redFlags].sort(), `${key} : rouges`)
      assert.deepEqual([...note.codes.alerts].sort(), [...(want.alerts ?? [])].sort(), `${key} : alertes`)
      if (want.fairPricePerShare === null) assert.equal(note.fairPricePerShare, null)
      assert.equal(note.fairPrice, null, `${key} : pas d'ordre ⇒ pas de prix total`)
      assert.equal(typeof note.score, 'number')
      assert.equal(note.verdict, want.verdict)
    })
  }
})

describe('cohérence note / verdict / prix', () => {
  const row = snapshot.vaults.sain
  const graph = graphDe(row)

  it('un first-loss très en dessous du minimum est rouge, même sans 0/0', () => {
    const troue = structuredClone(graph)
    troue.brokers[0].CoverAvailable = '1'
    troue.brokers[0].metrics.coverAvailable = '1'
    troue.brokers[0].metrics.coverRequired = '1000000'
    const note = analyse({ graph: troue, holders: row.holders, meta: row.meta })
    assert.ok(note.codes.red.includes('under-collateralised'))
    assert.ok(note.verdict !== 'sain')
  })

  it('une note basse ne peut pas sortir « sain »', () => {
    const codes = { red: [], alerts: [] }
    assert.equal(verdictFrom(codes, 36), 'à fuir')
    assert.equal(verdictFrom(codes, 50), 'risqué')
    assert.equal(verdictFrom(codes, 65), 'prudence')
    assert.equal(verdictFrom(codes, 90), 'sain')
  })

  it('fairPrice est le total de l\'ordre, fairPricePerShare le prix par part', () => {
    const sans = analyse({ graph, holders: row.holders, meta: row.meta })
    const avec = analyse({ graph, holders: row.holders, meta: row.meta, order: { shares: 12_500_000 } })
    assert.equal(sans.fairPrice, null)
    assert.equal(avec.fairPricePerShare, sans.fairPricePerShare)
    assert.equal(avec.fairPrice, Math.round((sans.fairPricePerShare * 12_500_000) / 1e6))
  })

  it('la NAV d\'un vault IOU au pair vaut celle d\'un vault XRP au pair', () => {
    const iou = graphDe(snapshot.vaults.iou)
    assert.equal(iou.metrics.navScaled, '1000000')
    assert.equal(graph.metrics.navScaled, '1000000')
  })
})

describe('clawbackArmed depuis world.json / snapshot', () => {
  it('iou sans meta : le catalogue pose le rouge clawback', () => {
    const row = snapshot.vaults.iou
    const note = analyse({ graph: graphDe(row), holders: row.holders })
    assert.ok(note.codes.red.includes('clawback-armed'))
    assert.equal(note.verdict, 'risqué')
  })

  it('sain sans meta : pas de clawback', () => {
    const row = snapshot.vaults.sain
    const note = analyse({ graph: graphDe(row), holders: row.holders })
    assert.ok(!note.codes.red.includes('clawback-armed'))
  })
})
