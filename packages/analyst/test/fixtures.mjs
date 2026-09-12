import { LoanFlags, VaultKind } from '@secondwave/core'

const NOW = 800_000_000

export const nowRipple = NOW

export const healthyVault = {
  vaultId: 'vault-a',
  assetsTotal: '10000',
  assetsAvailable: '5000',
  lossUnrealized: '0',
  sharesOutstanding: '10000',
  vaultKind: VaultKind.ClosedEnded,
  subscriptionDate: NOW - 200,
  redemptionDate: NOW + 86_400 * 30,
}

export const healthyBroker = {
  loanBrokerId: 'broker-a',
  vaultId: 'vault-a',
  debtTotal: '5000',
  coverAvailable: '1500',
  coverRateMinimum: 10_000,
  coverRateLiquidation: 5_000,
  managementFeeRate: 500,
  didVerified: true,
}

export const healthyLoans = [
  {
    loanId: 'loan-a1',
    principalOutstanding: '3000',
    totalValueOutstanding: '3100',
    managementFeeOutstanding: '10',
    nextPaymentDueDate: NOW + 3_600,
    gracePeriod: 60,
    flags: 0,
  },
  {
    loanId: 'loan-a2',
    principalOutstanding: '2000',
    totalValueOutstanding: '2050',
    managementFeeOutstanding: '5',
    nextPaymentDueDate: NOW + 7_200,
    gracePeriod: 60,
    flags: 0,
  },
]

export const speculativeBroker = {
  loanBrokerId: 'broker-b',
  vaultId: 'vault-b',
  debtTotal: '8000',
  coverAvailable: '800',
  coverRateMinimum: 10_000,
  coverRateLiquidation: 5_000,
  managementFeeRate: 500,
  didVerified: false,
}

export const speculativeVault = {
  ...healthyVault,
  vaultId: 'vault-b',
  assetsTotal: '10000',
  assetsAvailable: '2000',
}

export const speculativeLoans = [
  {
    loanId: 'loan-b1',
    principalOutstanding: '7000',
    totalValueOutstanding: '7200',
    managementFeeOutstanding: '20',
    nextPaymentDueDate: NOW + 1_200,
    gracePeriod: 60,
    flags: 0,
  },
  {
    loanId: 'loan-b2',
    principalOutstanding: '1000',
    totalValueOutstanding: '1020',
    managementFeeOutstanding: '2',
    nextPaymentDueDate: NOW + 1_200,
    gracePeriod: 60,
    flags: 0,
  },
]

export const crisisVault = {
  ...healthyVault,
  vaultId: 'vault-c',
  assetsTotal: '10000',
  assetsAvailable: '1000',
  lossUnrealized: '400',
}

export const crisisBroker = {
  loanBrokerId: 'broker-c',
  vaultId: 'vault-c',
  debtTotal: '6000',
  coverAvailable: '200',
  coverRateMinimum: 10_000,
  coverRateLiquidation: 5_000,
  managementFeeRate: 500,
  didVerified: false,
}

export const crisisLoans = [
  {
    loanId: 'loan-c1',
    principalOutstanding: '5000',
    totalValueOutstanding: '5200',
    managementFeeOutstanding: '15',
    nextPaymentDueDate: NOW - 10_000,
    gracePeriod: 60,
    flags: LoanFlags.lsfLoanDefault,
  },
  {
    loanId: 'loan-c2',
    principalOutstanding: '1000',
    totalValueOutstanding: '1050',
    managementFeeOutstanding: '3',
    nextPaymentDueDate: NOW - 200,
    gracePeriod: 60,
    flags: LoanFlags.lsfLoanImpaired,
  },
]

/** Prêt en retard, flags encore à 0 — NAV intacte, piège. */
export const latentLoans = [
  {
    loanId: 'loan-latent',
    principalOutstanding: '4000',
    totalValueOutstanding: '4100',
    managementFeeOutstanding: '8',
    nextPaymentDueDate: NOW - 120,
    gracePeriod: 60,
    flags: 0,
  },
]
