/**
 * Le seuil de solvabilité — la formule vient d'une mesure au drop près
 * (`probes-marche/07b-reserve-exacte.mjs`), pas d'une lecture de la doc.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { reserveFor, buyerSolvency, sellerSolvency, DEFAULT_RESERVE } from '../src/reserve.mjs'

test('réserve = base + inc × objets', () => {
  assert.equal(reserveFor(0, 0), 1_000_000n)
  assert.equal(reserveFor(1, 1), 1_400_000n)      // le cas mesuré : 1 credential + 1 MPToken
  assert.equal(reserveFor(5, 0), 2_000_000n)
  assert.equal(reserveFor(0, 0, { base: 200_000n, inc: 50_000n }), 200_000n)
})

test('⭐ le seuil exact mesuré : 1 drop de moins et rien ne bouge', () => {
  // Acheteur à OwnerCount 1, prix de 1 XRP, un MPToken à créer.
  const commun = { ownerCount: 1, priceDrops: 1_000_000n, newObjects: 1 }
  const seuil = 1_000_000n + reserveFor(1, 1)     // prix + réserve = 2,4 XRP

  assert.ok(buyerSolvency({ ...commun, balance: seuil }).ok, 'au seuil exact : doit passer')
  const sous = buyerSolvency({ ...commun, balance: seuil - 1n })
  assert.ok(!sous.ok, 'un drop sous le seuil : doit être refusé AVANT soumission')
  assert.equal(sous.missing, 1n)
  assert.match(sous.detail, /il manque 1 drops/)
})

test('l\'objet MPToken ne compte que s\'il doit être créé', () => {
  const base = { balance: 2_300_000n, ownerCount: 1, priceDrops: 1_000_000n }
  assert.ok(!buyerSolvency({ ...base, newObjects: 1 }).ok)   // 2,4 requis
  assert.ok(buyerSolvency({ ...base, newObjects: 0 }).ok)    // 2,2 requis — déjà autorisé
})

test('un prix hors XRP ne laisse que la réserve et les frais à couvrir', () => {
  const s = buyerSolvency({ balance: 1_400_000n, ownerCount: 1, priceDrops: 0n, newObjects: 1 })
  assert.ok(s.ok)
  assert.equal(s.required, 1_400_000n)
})

test('les frais entrent dans le seuil', () => {
  const sans = buyerSolvency({ balance: 1_400_000n, ownerCount: 1, priceDrops: 0n, newObjects: 1, fees: 0n })
  const avec = buyerSolvency({ balance: 1_400_000n, ownerCount: 1, priceDrops: 0n, newObjects: 1, fees: 1_020n })
  assert.ok(sans.ok && !avec.ok)
  assert.equal(avec.missing, 1_020n)
})

test('le vendeur aussi a une réserve — un escrow est un objet', () => {
  // À 1,25 XRP, un vendeur qui porte déjà un objet peut payer l'enveloppe du
  // Batch (1,2 de réserve + 200 drops) mais pas ouvrir un escrow (1,4 + 1 020).
  const batch = sellerSolvency({ balance: 1_250_000n, ownerCount: 1, newObjects: 0, fees: 200n })
  assert.ok(batch.ok, batch.detail)
  const htlc = sellerSolvency({ balance: 1_250_000n, ownerCount: 1, newObjects: 1, fees: 1_020n })
  assert.ok(!htlc.ok, 'le rail HTLC exige 0,2 XRP de plus chez le vendeur')
  assert.equal(htlc.required, 1_401_020n)
})

test('les valeurs par défaut sont celles du Devnet', () => {
  assert.deepEqual(DEFAULT_RESERVE, { base: 1_000_000n, inc: 200_000n })
})
