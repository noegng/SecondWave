/**
 * La survente — le bug trouvé par Noé.
 *
 * Un vendeur détenant 25 M de parts pouvait publier deux offres de 25 M. Le
 * carnet les affichait toutes les deux comme vivantes ; la seconde à trouver
 * preneur échouait au règlement, après que l'acheteur eut signé et que le
 * vendeur eut confirmé. Le pire endroit pour découvrir la contrainte.
 *
 * `canOffer()` compte les parts DÉJÀ promises — offres engagées comprises,
 * parce qu'une offre `matched` a quitté le carnet sans libérer ses parts.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { OrderBook, STATUS } from '../src/index.mjs'

const V = 'VAULT1'
const S = 'rSeller'
const B = 'rBuyer'
const M25 = 25_000_000n

const neuf = () => {
  const dir = mkdtempSync(join(tmpdir(), 'sw-book-'))
  const book = new OrderBook(join(dir, 'orderbook.json'))
  return { book, clean: () => rmSync(dir, { recursive: true, force: true }) }
}

test('une première offre au solde exact passe', () => {
  const { book, clean } = neuf()
  const r = book.canOffer({ seller: S, vaultId: V, shares: M25, balance: M25 })
  assert.equal(r.ok, true)
  assert.equal(r.free, M25)
  clean()
})

test('la seconde offre de 25 M sur un solde de 25 M est refusée', () => {
  const { book, clean } = neuf()
  book.post({ vaultId: V, seller: S, shares: String(M25), price: '1', ttl: null, sellerTickets: [1, 2] })
  const r = book.canOffer({ seller: S, vaultId: V, shares: M25, balance: M25 })
  assert.equal(r.ok, false)
  assert.equal(r.engaged, M25)
  assert.equal(r.free, 0n)
  assert.match(r.reason, /déjà promises/)
  clean()
})

test('une offre ENGAGÉE compte toujours — elle a quitté le carnet, pas le solde', () => {
  const { book, clean } = neuf()
  const o = book.post({ vaultId: V, seller: S, shares: String(M25), price: '1', ttl: null, sellerTickets: [1, 2] })
  book.match(o.id, { buyer: B, batch: { TicketSequence: 1 } })
  assert.equal(book.get(o.id).status, STATUS.MATCHED)
  assert.equal(book.list(V).length, 0, 'plus au carnet')
  assert.equal(book.live(V).length, 1, 'mais toujours vivante')

  const r = book.canOffer({ seller: S, vaultId: V, shares: 1n, balance: M25 })
  assert.equal(r.ok, false, 'une seule part de plus est déjà de trop')
  clean()
})

test('une offre réglée ou annulée libère les parts', () => {
  const { book, clean } = neuf()
  const a = book.post({ vaultId: V, seller: S, shares: String(M25), price: '1', ttl: null, sellerTickets: [1, 2] })
  book.cancel(a.id)
  assert.equal(book.canOffer({ seller: S, vaultId: V, shares: M25, balance: M25 }).ok, true)

  const b = book.post({ vaultId: V, seller: S, shares: String(M25), price: '1', ttl: null, sellerTickets: [3, 4] })
  book.match(b.id, { buyer: B, batch: {} })
  book.confirm(b.id, {})
  book.fill(b.id, 'HASH')
  assert.equal(book.canOffer({ seller: S, vaultId: V, shares: M25, balance: M25 }).ok, true)
  clean()
})

test('le partage se fait offre par offre, pas en tout-ou-rien', () => {
  const { book, clean } = neuf()
  book.post({ vaultId: V, seller: S, shares: '10000000', price: '1', ttl: null, sellerTickets: [1, 2] })
  const r = book.canOffer({ seller: S, vaultId: V, shares: 15_000_000n, balance: M25 })
  assert.equal(r.ok, true, '10 M engagés + 15 M demandés = 25 M : ça tient')
  const trop = book.canOffer({ seller: S, vaultId: V, shares: 15_000_001n, balance: M25 })
  assert.equal(trop.ok, false, 'une part de plus ne tient plus')
  clean()
})

test('les vaults et les vendeurs ne se contaminent pas', () => {
  const { book, clean } = neuf()
  book.post({ vaultId: V, seller: S, shares: String(M25), price: '1', ttl: null, sellerTickets: [1, 2] })
  assert.equal(book.canOffer({ seller: S, vaultId: 'AUTRE', shares: M25, balance: M25 }).ok, true)
  assert.equal(book.canOffer({ seller: 'rAutre', vaultId: V, shares: M25, balance: M25 }).ok, true)
  clean()
})

test('modifier une offre existante ne se compte pas contre elle-même', () => {
  const { book, clean } = neuf()
  const o = book.post({ vaultId: V, seller: S, shares: String(M25), price: '1', ttl: null, sellerTickets: [1, 2] })
  const r = book.canOffer({ seller: S, vaultId: V, shares: M25, balance: M25, except: o.id })
  assert.equal(r.ok, true)
  clean()
})

test('une offre de zéro part est refusée', () => {
  const { book, clean } = neuf()
  assert.equal(book.canOffer({ seller: S, vaultId: V, shares: 0n, balance: M25 }).ok, false)
  clean()
})

test("l'acheteur peut retirer son engagement : l'offre revient au carnet", () => {
  const { book, clean } = neuf()
  const o = book.post({ vaultId: V, seller: S, shares: String(M25), price: '1', ttl: null, sellerTickets: [1, 2] })
  book.match(o.id, { buyer: B, batch: { TicketSequence: 1 } })

  const faux = { classicAddress: B }
  const brule = async () => ({ ok: true, hash: 'H', url: 'U' })
  return book.withdrawCommitment(null, faux, o.id, { withdrawCommitment: brule }).then(r => {
    assert.equal(r.ok, true)
    const apres = book.get(o.id)
    assert.equal(apres.status, STATUS.OPEN)
    assert.equal(apres.buyer, null)
    assert.equal(apres.batch, null)
    assert.equal(book.list(V).length, 1, 'de nouveau achetable')
    clean()
  })
})

test("un tiers ne peut pas retirer l'engagement d'un autre", async () => {
  const { book, clean } = neuf()
  const o = book.post({ vaultId: V, seller: S, shares: String(M25), price: '1', ttl: null, sellerTickets: [1, 2] })
  book.match(o.id, { buyer: B, batch: {} })
  const r = await book.withdrawCommitment(null, { classicAddress: 'rIntrus' }, o.id,
    { withdrawCommitment: async () => ({ ok: true }) })
  assert.equal(r.ok, false)
  assert.equal(book.get(o.id).status, STATUS.MATCHED)
  clean()
})
