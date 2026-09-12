/** Les moyens de paiement — normalisation et garde-fous. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeAmount, sameAsset, assetKey, pricePerUnit, priceLabel } from '../src/amounts.mjs'

const USD = { currency: 'USD', issuer: 'rDGCp89kLBzfZbH7EL3XmfaPYkxMMXTn3b', value: '5' }
const MPT = { mpt_issuance_id: '005023B84F54C9D95EBDDCBA4817941F7B2102985D09F92D', value: '360000' }

test('XRP : drops en string, bigint ou number entier', () => {
  for (const v of ['1500000', 1500000n, 1500000]) {
    const a = normalizeAmount(v)
    assert.equal(a.kind, 'XRP')
    assert.equal(a.raw, '1500000')          // le champ Amount d'une transaction
    assert.equal(a.drops, 1500000n)
  }
  assert.equal(normalizeAmount('0').drops, 0n)
})

test('XRP : ce qui n\'est pas un entier de drops est refusé', () => {
  for (const bad of ['1.5', '-3', '1e6', 'abc', 1.5])
    assert.throws(() => normalizeAmount(bad), TypeError, `accepté à tort : ${bad}`)
})

test('IOU : devise, émetteur et valeur décimale', () => {
  const a = normalizeAmount(USD)
  assert.equal(a.kind, 'IOU')
  assert.equal(a.currency, 'USD')
  assert.deepEqual(a.raw, USD)
  assert.match(a.label, /^5 USD\./)
  assert.throws(() => normalizeAmount({ currency: 'USD', value: '5' }), /émetteur/)
  assert.throws(() => normalizeAmount({ ...USD, value: '0' }), /valeur IOU/)
  assert.throws(() => normalizeAmount({ ...USD, currency: 'DOLLAR' }), /devise/)
})

test('MPT : identifiant de 48 hex et quantité entière', () => {
  const a = normalizeAmount(MPT)
  assert.equal(a.kind, 'MPT')
  assert.equal(a.value, '360000')
  assert.deepEqual(a.raw, MPT)
  assert.throws(() => normalizeAmount({ mpt_issuance_id: 'ABC', value: '1' }), /mpt_issuance_id/)
  assert.throws(() => normalizeAmount({ ...MPT, value: '0' }), /quantité/)
})

test('MPT est reconnu avant IOU — les deux portent `value`', () => {
  assert.equal(normalizeAmount({ ...MPT, currency: 'USD' }).kind, 'MPT')
})

test('sameAsset compare l\'actif, jamais la quantité', () => {
  assert.ok(sameAsset('1', '999999'))
  assert.ok(sameAsset(USD, { ...USD, value: '12' }))
  assert.ok(!sameAsset(USD, { ...USD, issuer: 'rQQQp89kLBzfZbH7EL3XmfaPYkxMMXTn3b' }))
  assert.ok(!sameAsset(USD, MPT))
  assert.ok(!sameAsset('1000', MPT))
})

test('assetKey est stable et distingue les trois familles', () => {
  assert.equal(assetKey('10'), 'XRP')
  assert.equal(assetKey(MPT), `MPT:${MPT.mpt_issuance_id}`)
  assert.equal(assetKey(USD), `IOU:USD.${USD.issuer}`)
})

test('prix unitaire et libellé', () => {
  assert.equal(pricePerUnit('880000', 1_000_000), 0.88)
  assert.equal(pricePerUnit('880000', 0), null)
  assert.match(priceLabel('880000', 1_000_000), /0\.880000 drops\/part/)
  assert.match(priceLabel(USD, 1000), /USD\/part/)
})

test('un montant manquant lève plutôt que de produire un prix nul', () => {
  assert.throws(() => normalizeAmount(null), /manquant/)
  assert.throws(() => normalizeAmount(undefined), /manquant/)
})
