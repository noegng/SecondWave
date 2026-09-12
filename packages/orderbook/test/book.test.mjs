/**
 * Le carnet — les deux bugs relevés par les sondes, et leur correctif.
 *   F51  fill() sans garde de statut écrasait la preuve on-chain du vrai acheteur
 *   F48  la couverture n'était jamais vérifiée en cumul : survente affichable
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { OrderBook, STATUS, allocateCoverage } from '../src/index.mjs'

const bookNeuf = () => new OrderBook(join(mkdtempSync(join(tmpdir(), 'sw-book-')), 'orderbook.json'))
const V = 'VAULT1', S = 'rSELLER', T = 'rSELLER2'

test('F51 — une offre ne se remplit qu\'une fois', () => {
  const b = bookNeuf()
  const o = b.post({ vaultId: V, seller: S, shares: 1000, price: 900 })

  const premier = b.fill(o.id, 'HASH_ACHETEUR_1')
  assert.ok(premier.ok)
  assert.equal(premier.order.status, STATUS.FILLED)

  const second = b.fill(o.id, 'HASH_ACHETEUR_2')
  assert.ok(!second.ok, 'le second règlement doit être refusé')
  assert.match(second.reason, /déjà filled/)
  assert.equal(b.get(o.id).txHash, 'HASH_ACHETEUR_1', 'la preuve du vrai acheteur est conservée')
})

test('F51 — une offre annulée ou expirée ne se remplit pas', () => {
  const b = bookNeuf()
  const annulee = b.post({ vaultId: V, seller: S, shares: 1000, price: 900 })
  b.cancel(annulee.id)
  const r1 = b.fill(annulee.id, 'HASH')
  assert.ok(!r1.ok)
  assert.equal(b.get(annulee.id).txHash, null)

  const expiree = b.post({ vaultId: V, seller: S, shares: 1000, price: 900, ttl: -1 })
  const r2 = b.fill(expiree.id, 'HASH')
  assert.ok(!r2.ok)
  assert.match(r2.reason, /expirée/)

  assert.ok(!b.fill('o999', 'HASH').ok)
})

test('F48 — la couverture est allouée en cumul, dans l\'ordre de publication', () => {
  const orders = [
    { id: 'o001', seller: S, vaultId: V, shares: '600000', postedAt: 10 },
    { id: 'o002', seller: S, vaultId: V, shares: '600000', postedAt: 20 },
  ]
  const cov = allocateCoverage(orders, new Map([[`${S}|${V}`, 1_000_000n]]))
  assert.ok(cov.get('o001').covered, 'la première offre tient dans le solde')
  assert.ok(!cov.get('o002').covered, 'la seconde dépasse le cumul — c\'était le bug')
  assert.match(cov.get('o002').reason, /couverture cumulée dépassée/)
  assert.match(cov.get('o002').reason, /600000 parts déjà engagées/)
})

test('F48 — deux vendeurs, ou deux vaults, ne se marchent pas dessus', () => {
  const orders = [
    { id: 'o001', seller: S, vaultId: V, shares: '900000', postedAt: 10 },
    { id: 'o002', seller: T, vaultId: V, shares: '900000', postedAt: 20 },
    { id: 'o003', seller: S, vaultId: 'VAULT2', shares: '900000', postedAt: 30 },
  ]
  const cov = allocateCoverage(orders, new Map([
    [`${S}|${V}`, 1_000_000n], [`${T}|${V}`, 1_000_000n], [`${S}|VAULT2`, 1_000_000n],
  ]))
  for (const id of ['o001', 'o002', 'o003']) assert.ok(cov.get(id).covered, `${id} doit être couverte`)
})

test('F48 — un vendeur sans parts : le message donne le solde réel', () => {
  const cov = allocateCoverage(
    [{ id: 'o001', seller: S, vaultId: V, shares: '500000', postedAt: 1 }],
    new Map([[`${S}|${V}`, 42n]]))
  assert.ok(!cov.get('o001').covered)
  assert.match(cov.get('o001').reason, /n'a plus que 42 parts/)
})

test('F48 — un solde inconnu vaut zéro, jamais « couvert »', () => {
  const cov = allocateCoverage([{ id: 'o001', seller: S, vaultId: V, shares: '1', postedAt: 1 }], new Map())
  assert.ok(!cov.get('o001').covered)
})

test('list() n\'expose que les offres ouvertes et non expirées', () => {
  const b = bookNeuf()
  const vivante = b.post({ vaultId: V, seller: S, shares: 1, price: 1 })
  const morte = b.post({ vaultId: V, seller: S, shares: 1, price: 1, ttl: -1 })
  const annulee = b.post({ vaultId: V, seller: S, shares: 1, price: 1 })
  b.cancel(annulee.id)
  const ids = b.list(V).map(o => o.id)
  assert.deepEqual(ids, [vivante.id])
  assert.deepEqual(b.list('AUTRE'), [])
  rmSync(b.path, { force: true })
})
