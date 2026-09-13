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

/* ── L'échéance de l'engagement ─────────────────────────────────────────────
   Sans elle, le vendeur détient une option gratuite sans fin : il exécute le
   jour qui l'arrange, au prix d'hier. C'est le seul endroit du rail où une
   échéance protège quelqu'un — l'annonce, elle, n'engage personne. */

test("un engagement périmé rend l'offre au carnet", () => {
  const { book, clean } = neuf()
  const o = book.post({ vaultId: V, seller: S, shares: '100', price: '1', ttl: null, sellerTickets: [1, 2] })
  book.match(o.id, { buyer: B, batch: { LastLedgerSequence: 5_000_000 }, expiresAtLedger: 5_000_000 })
  assert.equal(book.get(o.id).status, STATUS.MATCHED)

  assert.equal(book.commitmentExpired(book.get(o.id), 4_999_999), false, 'pas encore')
  assert.deepEqual(book.sweepCommitments(4_999_999), [], 'rien à balayer avant l\'échéance')

  assert.equal(book.commitmentExpired(book.get(o.id), 5_000_001), true)
  assert.deepEqual(book.sweepCommitments(5_000_001), [o.id])
  const apres = book.get(o.id)
  assert.equal(apres.status, STATUS.OPEN)
  assert.equal(apres.buyer, null)
  assert.equal(apres.batch, null)
  assert.equal(apres.expiresAtLedger, null)
  assert.equal(book.list(V).length, 1, 'de nouveau achetable')
  clean()
})

test('les parts sont rendues quand un engagement expire', () => {
  const { book, clean } = neuf()
  const o = book.post({ vaultId: V, seller: S, shares: String(M25), price: '1', ttl: null, sellerTickets: [1, 2] })
  book.match(o.id, { buyer: B, batch: {}, expiresAtLedger: 100 })
  assert.equal(book.canOffer({ seller: S, vaultId: V, shares: 1n, balance: M25 }).ok, false)
  book.sweepCommitments(101)
  // L'offre est rendue au carnet : elle promet toujours ses parts, donc
  // toujours pas de place pour une seconde — mais elle est de nouveau à prendre.
  assert.equal(book.get(o.id).status, STATUS.OPEN)
  assert.equal(book.engagedShares(S, V), M25)
  clean()
})

test("une offre sans échéance ne périme jamais, même très loin dans le futur", () => {
  const { book, clean } = neuf()
  const o = book.post({ vaultId: V, seller: S, shares: '100', price: '1', ttl: null, sellerTickets: [1, 2] })
  book.match(o.id, { buyer: B, batch: {} })       // aucun LastLedgerSequence
  assert.equal(book.get(o.id).expiresAtLedger, null)
  assert.equal(book.commitmentExpired(book.get(o.id), 999_999_999), false)
  assert.deepEqual(book.sweepCommitments(999_999_999), [])
  clean()
})

/* ── Le sur-engagement, côté acheteur ───────────────────────────────────────
   Symétrique de la survente. Rien n'empêchait de s'engager sur trois lots avec
   de quoi en payer un : `tfAllOrNothing` évite le double débit, mais deux
   vendeurs confirment pour rien et l'acheteur croit avoir acheté trois fois. */

/** Version minimale de `buyerSolvency` — le vrai vit dans @secondwave/settlement. */
const solvency = ({ balance, ownerCount = 0, priceDrops = 0n, fees = 0n, newObjects = 1 }) => {
  const need = 1_000_000n + 200_000n * BigInt(ownerCount + newObjects)
  const required = BigInt(priceDrops) + need + BigInt(fees)
  const ok = BigInt(balance) >= required
  return { ok, required, missing: ok ? 0n : required - BigInt(balance), detail: `${balance} vs ${required}` }
}

const offreDe = (book, prix) =>
  book.post({ vaultId: V, seller: S, shares: '1', price: String(prix), sellerTickets: [1, 2] })

test('un premier engagement dans les moyens passe', () => {
  const { book, clean } = neuf()
  const o = offreDe(book, 30_000_000n)
  const r = book.canCommit({ buyer: B, price: o.price, balance: 50_000_000n, solvency })
  assert.equal(r.ok, true)
  assert.equal(r.engaged, 0n)
  clean()
})

test('le second engagement qui dépasse le solde est refusé', () => {
  const { book, clean } = neuf()
  const a = offreDe(book, 30_000_000n)
  book.match(a.id, { buyer: B, batch: {} })
  const b = offreDe(book, 30_000_000n)
  const r = book.canCommit({ buyer: B, price: b.price, balance: 50_000_000n, solvency })
  assert.equal(r.ok, false)
  assert.equal(r.engaged, 30_000_000n)
  assert.match(r.reason, /déjà engagés/)
  clean()
})

test('un achat réglé ou retiré libère le budget', () => {
  const { book, clean } = neuf()
  const a = offreDe(book, 30_000_000n)
  book.match(a.id, { buyer: B, batch: {} })
  book.confirm(a.id, {})
  book.fill(a.id, 'HASH')
  const b = offreDe(book, 30_000_000n)
  const r = book.canCommit({ buyer: B, price: b.price, balance: 50_000_000n, solvency })
  assert.equal(r.ok, true, 'un achat réglé a quitté les engagements')
  assert.equal(r.engaged, 0n)
  clean()
})

test('les engagements des autres acheteurs ne me sont pas comptés', () => {
  const { book, clean } = neuf()
  const a = offreDe(book, 30_000_000n)
  book.match(a.id, { buyer: 'rQuelquUnDautre', batch: {} })
  const b = offreDe(book, 30_000_000n)
  assert.equal(book.canCommit({ buyer: B, price: b.price, balance: 50_000_000n, solvency }).ok, true)
  clean()
})

test('chaque achat en attente ajoute sa part de réserve', () => {
  const { book, clean } = neuf()
  const a = offreDe(book, 10_000_000n)
  book.match(a.id, { buyer: B, batch: {} })
  const b = offreDe(book, 10_000_000n)
  // 20 XRP de prix + base 1 + 0,2 × 2 nouveaux objets = 21,4 XRP exigés.
  assert.equal(book.canCommit({ buyer: B, price: b.price, balance: 21_400_000n, solvency }).ok, true)
  assert.equal(book.canCommit({ buyer: B, price: b.price, balance: 21_399_999n, solvency }).ok, false,
    'un drop de moins et le second MPToken n\'est plus couvert')
  clean()
})
