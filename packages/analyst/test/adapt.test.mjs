import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { adaptBroker, adaptCase, adaptLoan, adaptVault } from '../src/adapt.mjs'
import { analyzeOffer } from '../src/analyze.mjs'
import { LoanFlags } from '@secondwave/core'

describe('adaptVault', () => {
  it('lit un vault_info PascalCase', () => {
    const v = adaptVault({
      vault: {
        Account: 'rPseudoVault',
        Owner: 'rBroker',
        AssetsTotal: '10000',
        AssetsAvailable: '4000',
        LossUnrealized: '100',
        ShareMPTID: '00000001ABC',
        index: 'VAULTINDEX',
        VaultKind: 1,
        SubscriptionDate: 800_000_000,
        RedemptionDate: 800_086_400,
        shares: { OutstandingAmount: '10000' },
      },
    })
    assert.equal(v.vaultId, 'VAULTINDEX')
    assert.equal(v.assetsTotal, '10000')
    assert.equal(v.sharesOutstanding, '10000')
    assert.equal(v.vaultKind, 1)
    assert.equal(v.lossUnrealized, '100')
  })
})

describe('adaptBroker / adaptLoan', () => {
  it('lit des ledger_entry LoanBroker + Loan', () => {
    const b = adaptBroker({
      node: {
        index: 'BROKER1',
        VaultID: 'VAULTINDEX',
        DebtTotal: '5000',
        CoverAvailable: '1500',
        CoverRateMinimum: 10_000,
        CoverRateLiquidation: 50_000,
        ManagementFeeRate: 500,
      },
    })
    assert.equal(b.loanBrokerId, 'BROKER1')
    assert.equal(b.coverRateMinimum, 10_000)
    assert.equal(b.debtTotal, '5000')

    const l = adaptLoan({
      result: {
        node: {
          index: 'LOAN1',
          LoanBrokerID: 'BROKER1',
          PrincipalOutstanding: '3000',
          TotalValueOutstanding: '3100',
          ManagementFeeOutstanding: '10',
          NextPaymentDueDate: 800_010_000,
          GracePeriod: 60,
          Flags: LoanFlags.lsfLoanImpaired,
        },
      },
    })
    assert.equal(l.loanId, 'LOAN1')
    assert.equal(l.flags, LoanFlags.lsfLoanImpaired)
  })
})

describe('adaptCase', () => {
  it('branche du JSON brut sur analyzeOffer', () => {
    const r = analyzeOffer(
      adaptCase({
        nowRipple: 800_000_100,
        offer: { shares: 1000, discount: 0.03 },
        vault: {
          index: 'V',
          AssetsTotal: '10000',
          AssetsAvailable: '5000',
          LossUnrealized: '0',
          VaultKind: 1,
          SubscriptionDate: 800_000_000 - 200,
          RedemptionDate: 800_000_000 + 86_400,
          shares: { OutstandingAmount: '10000' },
        },
        broker: {
          index: 'B',
          DebtTotal: '5000',
          CoverAvailable: '1500',
          CoverRateMinimum: 10_000,
          CoverRateLiquidation: 50_000,
          didVerified: true,
        },
        loans: [
          {
            PrincipalOutstanding: '5000',
            TotalValueOutstanding: '5100',
            NextPaymentDueDate: 800_010_000,
            GracePeriod: 60,
            Flags: 0,
          },
        ],
      }),
    )
    assert.ok(r.score.riskScore > 0)
    assert.equal(r.classification.kind, 'liquidity')
    assert.ok(r.nav > 0)
  })
})
