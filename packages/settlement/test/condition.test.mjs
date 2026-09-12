/** Crypto-conditions PreimageSha256 — la charnière du rail HTLC. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  makeCondition, verifyCondition, preimageOf, fulfillmentOf, conditionalFinishFee,
} from '../src/condition.mjs'

test('condition et fulfillment ont la forme DER attendue par le ledger', () => {
  const { condition, fulfillment, preimage } = makeCondition(Buffer.alloc(32, 7))
  assert.match(condition, /^A0258020[0-9A-F]{64}810120$/)   // 0x20 = 32 octets de préimage
  assert.match(fulfillment, /^A0228020[0-9A-F]{64}$/)       // A0 <34> 80 <32> <préimage>
  assert.equal(preimage, '07'.repeat(32).toUpperCase())
  // le digest annoncé est bien celui de la préimage
  assert.equal(condition.slice(8, 72), createHash('sha256').update(Buffer.alloc(32, 7)).digest('hex').toUpperCase())
})

test('la même préimage donne toujours la même condition', () => {
  const a = makeCondition(Buffer.from('secret-de-hugo'))
  const b = makeCondition(Buffer.from('secret-de-hugo'))
  assert.deepEqual(a, b)
})

test('deux tirages aléatoires diffèrent', () => {
  assert.notEqual(makeCondition().condition, makeCondition().condition)
})

test('verifyCondition accepte le bon secret et rejette tout le reste', () => {
  const good = makeCondition()
  const other = makeCondition()
  assert.ok(verifyCondition(good.condition, good.fulfillment))
  assert.ok(!verifyCondition(good.condition, other.fulfillment))
  assert.ok(!verifyCondition(good.condition, 'A0228020' + 'FF'.repeat(32)))
  assert.ok(!verifyCondition(good.condition, ''))
  assert.ok(!verifyCondition(good.condition, null))
})

test('une préimage hors bornes est refusée (longueurs DER sur un octet)', () => {
  assert.throws(() => makeCondition(Buffer.alloc(0)), RangeError)
  assert.throws(() => makeCondition(Buffer.alloc(128)), RangeError)
  assert.doesNotThrow(() => makeCondition(Buffer.alloc(127)))
})

test('preimageOf rejette les fulfillments malformés', () => {
  assert.throws(() => preimageOf('B0228020'), /PreimageSha256/)
  assert.throws(() => preimageOf('A022' + '81' + '20' + 'AA'.repeat(32)), /champ 0/)
  assert.throws(() => preimageOf('A0998020' + 'AA'.repeat(32)), /longueurs/)
  assert.throws(() => preimageOf('A0228020AABB'), /tronquée/)
})

test('makeCondition accepte une préimage en hex ou en texte', () => {
  assert.equal(makeCondition('AABB').preimage, 'AABB')
  assert.equal(makeCondition('salut').preimage, Buffer.from('salut').toString('hex').toUpperCase())
})

test('fulfillmentOf lit les deux formes de réponse de l\'API v2', () => {
  assert.equal(fulfillmentOf({ tx_json: { Fulfillment: 'A0' } }), 'A0')
  assert.equal(fulfillmentOf({ Fulfillment: 'B0' }), 'B0')
  assert.equal(fulfillmentOf({}), null)
})

test('le frais d\'un EscrowFinish conditionnel dépasse toujours le frais de base', () => {
  const { fulfillment } = makeCondition()
  const fee = BigInt(conditionalFinishFee(fulfillment))
  assert.ok(fee >= 1000n, `frais trop bas : ${fee}`)
  // un fulfillment plus long coûte au moins autant
  assert.ok(BigInt(conditionalFinishFee('AA'.repeat(200))) >= fee)
})
