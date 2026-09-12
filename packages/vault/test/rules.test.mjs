/**
 * Tests hors ligne des règles XLS-65/66 encodées (Lot 1).
 * Une règle = un cas passant + un cas refusé + le message vérifié.
 *   node --test packages/vault/test
 * Chaque cas refusé cite le renvoi probes/RESULTATS.md dans son nom.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  VaultError,
  assertVaultDates, assertScale, assertWithdrawalPolicy, assertDataHex, assertDomainFlag,
  assertCoverRates, assertManagementFee, assertBrokerUpdateAllowed,
  assertLoanSchedule, assertInterestRate, assertNoForbiddenLoanFields,
  assertLoanEndsBeforeRedemption,
  interestOver, coverRequired, coverPayoutAtDefault,
  MIN_PHASE_GAP, MANAGEMENT_FEE_MAX,
} from '../src/rules.mjs'

/** Vérifie qu'un appel jette un VaultError du bon code, dont le message cite la valeur. */
function refuse(fn, code, mustContain) {
  try { fn(); assert.fail('aurait dû jeter') }
  catch (e) {
    assert.ok(e instanceof VaultError, `attendu VaultError, reçu ${e?.name}`)
    assert.equal(e.code, code)
    if (mustContain) assert.match(e.message, mustContain)
    assert.ok(e.remede && e.remede.length > 0, 'un remède actionnable est attendu')
  }
}

test('dates closed-ended : les deux requises [A-2/3]', () => {
  assert.doesNotThrow(() => assertVaultDates({ subscriptionDate: 100, redemptionDate: 100 + MIN_PHASE_GAP }))
  refuse(() => assertVaultDates({ subscriptionDate: 100, redemptionDate: null }), 'CLOSED_DATES_REQUIRED')
})

test('écart de phase : plancher 180 s [A-6]', () => {
  assert.doesNotThrow(() => assertVaultDates({ subscriptionDate: 0, redemptionDate: 180 }))
  refuse(() => assertVaultDates({ subscriptionDate: 0, redemptionDate: 179 }), 'PHASE_GAP_RANGE', /179/)
})

test('écart de phase : plafond ~30 ans [A-7]', () => {
  refuse(() => assertVaultDates({ subscriptionDate: 0, redemptionDate: 31 * 31536000 }), 'PHASE_GAP_RANGE')
})

test('Scale interdit sur XRP/MPT, borné sur IOU [A-8/9/10]', () => {
  assert.doesNotThrow(() => assertScale({ currency: 'USD', issuer: 'rI' }, 6))
  assert.doesNotThrow(() => assertScale({ currency: 'XRP' }, null))
  refuse(() => assertScale({ currency: 'XRP' }, 6), 'SCALE_FORBIDDEN')
  refuse(() => assertScale({ mpt_issuance_id: 'X' }, 2), 'SCALE_FORBIDDEN')
  refuse(() => assertScale({ currency: 'USD', issuer: 'rI' }, 19), 'SCALE_RANGE', /19/)
})

test('WithdrawalPolicy : seule 1 [A-12]', () => {
  assert.doesNotThrow(() => assertWithdrawalPolicy(1))
  refuse(() => assertWithdrawalPolicy(2), 'WITHDRAWAL_POLICY', /2/)
})

test('Data : hex pair, 1..256 octets [A-13]', () => {
  assert.doesNotThrow(() => assertDataHex('ABCD'))
  refuse(() => assertDataHex(''), 'DATA_MALFORMED')
  refuse(() => assertDataHex('ABC'), 'DATA_MALFORMED')
  refuse(() => assertDataHex('AB'.repeat(257)), 'DATA_TOO_LONG', /257/)
})

test('DomainID impose tfVaultPrivate [A-17]', () => {
  assert.doesNotThrow(() => assertDomainFlag({ domainId: 'D', flags: 0x00010000 }))
  refuse(() => assertDomainFlag({ domainId: 'D', flags: 0 }), 'DOMAIN_NEEDS_PRIVATE')
})

test('CoverRate : les deux nuls ou les deux non nuls [E-51/52]', () => {
  assert.doesNotThrow(() => assertCoverRates({ coverRateMinimum: 0, coverRateLiquidation: 0 }))
  assert.doesNotThrow(() => assertCoverRates({ coverRateMinimum: 10000, coverRateLiquidation: 50000 }))
  refuse(() => assertCoverRates({ coverRateMinimum: 10000, coverRateLiquidation: 0 }), 'COVER_RATES_PAIRED')
})

test('ManagementFeeRate ∈ [0,10000] [E-59]', () => {
  assert.doesNotThrow(() => assertManagementFee(MANAGEMENT_FEE_MAX))
  refuse(() => assertManagementFee(10001), 'MANAGEMENT_FEE_RANGE', /10001/)
})

test('CoverRate et fee immuables après création [X1/Y2]', () => {
  assert.doesNotThrow(() => assertBrokerUpdateAllowed({ debtMaximum: '100', data: 'x' }))
  refuse(() => assertBrokerUpdateAllowed({ coverRateMinimum: 1 }), 'BROKER_FIELD_IMMUTABLE')
  refuse(() => assertBrokerUpdateAllowed({ managementFeeRate: 500 }), 'BROKER_FIELD_IMMUTABLE')
})

test('LA règle : 60 ≤ GracePeriod ≤ PaymentInterval [F/g-sweep]', () => {
  assert.doesNotThrow(() => assertLoanSchedule({ paymentInterval: 120, paymentTotal: 2, gracePeriod: 60 }))
  assert.doesNotThrow(() => assertLoanSchedule({ paymentInterval: 120, paymentTotal: 2, gracePeriod: 120 }))
  refuse(() => assertLoanSchedule({ paymentInterval: 120, paymentTotal: 2, gracePeriod: 59 }), 'GRACE_PERIOD_RANGE', /59/)
  refuse(() => assertLoanSchedule({ paymentInterval: 120, paymentTotal: 2, gracePeriod: 121 }), 'GRACE_PERIOD_RANGE')
  refuse(() => assertLoanSchedule({ paymentInterval: 30, paymentTotal: 1, gracePeriod: 60 }), 'PAYMENT_INTERVAL_MIN', /30/)
  refuse(() => assertLoanSchedule({ paymentInterval: 120, paymentTotal: 0, gracePeriod: 60 }), 'PAYMENT_TOTAL_MIN')
})

test('InterestRate borné [F-72]', () => {
  assert.doesNotThrow(() => assertInterestRate(50000))
  refuse(() => assertInterestRate(4294967295), 'INTEREST_RATE_RANGE')
})

test('StartDate et Data interdits sur LoanSet [F-74/75]', () => {
  assert.doesNotThrow(() => assertNoForbiddenLoanFields({ startDate: undefined, data: undefined }))
  refuse(() => assertNoForbiddenLoanFields({ startDate: 123 }), 'LOANSET_STARTDATE')
  refuse(() => assertNoForbiddenLoanFields({ data: 'DEAD' }), 'LOANSET_DATA_DROPPED')
})

test('marge de fin de prêt vs RedemptionDate [F-69/X2]', () => {
  // at=0, dernière échéance à 100s, red à 400 → marge 300 ≥ 90 : OK
  assert.doesNotThrow(() => assertLoanEndsBeforeRedemption({ paymentInterval: 100, paymentTotal: 1, redemptionDate: 400, at: 0 }))
  // dernière échéance à 350s, red 400 → marge 50 < 90 : refus
  refuse(() => assertLoanEndsBeforeRedemption({ paymentInterval: 350, paymentTotal: 1, redemptionDate: 400, at: 0 }), 'LOAN_END_MARGIN')
  // sans redemptionDate on ne peut rien vérifier : ne jette pas
  assert.doesNotThrow(() => assertLoanEndsBeforeRedemption({ paymentInterval: 999, paymentTotal: 9, redemptionDate: null, at: 0 }))
})

test('formules : intérêt annualisé, cover exigé, ponction au défaut [F-72/E-55/G-85]', () => {
  // 10 XRP à 100000 (=100 %/an) sur 200 s ≈ 63 drops [F-72 : mesuré 64]
  assert.equal(interestOver('10000000', 100000, 200), 63n)
  // cover exigé = dette × min/1e5 : 10 XRP × 10 % = 1 XRP
  assert.equal(coverRequired('10000000', 10000), 1000000n)
  // ponction au défaut = principal × min × liq / 1e5² : 4 XRP × 10 % × 50 % = 0,2 XRP [G-85]
  assert.equal(coverPayoutAtDefault('4000000', 10000, 50000), 200000n)
})
