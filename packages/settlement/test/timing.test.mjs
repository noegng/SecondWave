/**
 * Le décalage des CancelAfter — c'est la seule pièce de sécurité du rail HTLC,
 * donc la plus testée. Voir le raisonnement en tête de `src/timing.mjs`.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { planTimings, validateTimings, claimWindow, MIN_MARGIN, MIN_OFFER_TTL } from '../src/timing.mjs'

const NOW = 800_000_000

test('le prix expire AVANT les parts, d\'au moins la marge', () => {
  const t = planTimings({ now: NOW, ttl: 600 })
  assert.equal(t.sharesCancelAfter, NOW + 600)
  assert.equal(t.priceCancelAfter, NOW + 600 - MIN_MARGIN)
  assert.ok(t.priceCancelAfter < t.sharesCancelAfter)
  assert.ok(validateTimings({ ...t, now: NOW }).ok)
})

test('un ttl ou une marge trop courts sont refusés à la construction', () => {
  assert.throws(() => planTimings({ now: NOW, ttl: MIN_OFFER_TTL - 1 }), RangeError)
  assert.throws(() => planTimings({ now: NOW, ttl: 600, margin: MIN_MARGIN - 1 }), RangeError)
  assert.throws(() => planTimings({ now: NOW, ttl: 200, margin: 200 }), RangeError)
  assert.throws(() => planTimings({ now: 'maintenant', ttl: 600 }), TypeError)
})

test('⭐ le piège du HTLC : prix qui expire APRÈS les parts', () => {
  const v = validateTimings({ sharesCancelAfter: NOW + 300, priceCancelAfter: NOW + 600, now: NOW })
  assert.ok(!v.ok)
  assert.match(v.problems.join(' '), /doit expirer AVANT/)
})

test('même ordre correct, une marge trop mince est refusée', () => {
  const v = validateTimings({ sharesCancelAfter: NOW + 600, priceCancelAfter: NOW + 590, now: NOW })
  assert.ok(!v.ok)
  assert.match(v.problems.join(' '), /marge de 10s/)
})

test('🔴 un CancelAfter manquant est une erreur, jamais un défaut', () => {
  const sansParts = validateTimings({ priceCancelAfter: NOW + 100, now: NOW })
  assert.ok(!sansParts.ok)
  assert.match(sansParts.problems.join(' '), /irrécupérable/)
  const sansPrix = validateTimings({ sharesCancelAfter: NOW + 600, now: NOW })
  assert.ok(!sansPrix.ok)
  assert.match(sansPrix.problems.join(' '), /irrécupérable/)
})

test('une offre déjà expirée, ou sur le point de l\'être, est refusée', () => {
  assert.ok(!validateTimings({ sharesCancelAfter: NOW + 10, priceCancelAfter: NOW - 10, now: NOW }).ok)
  const juste = validateTimings({ sharesCancelAfter: NOW + 200, priceCancelAfter: NOW + 30, now: NOW })
  assert.ok(!juste.ok)
  assert.match(juste.problems.join(' '), /trop court/)
})

test('claimWindow dit au vendeur combien de temps il lui reste', () => {
  assert.deepEqual(claimWindow({ priceCancelAfter: NOW + 300, now: NOW }),
    { open: true, secondsLeft: 300, warning: null })
  const serre = claimWindow({ priceCancelAfter: NOW + 30, now: NOW })
  assert.ok(serre.open && serre.warning)
  const ferme = claimWindow({ priceCancelAfter: NOW - 1, now: NOW })
  assert.ok(!ferme.open)
})
