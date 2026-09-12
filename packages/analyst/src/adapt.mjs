import { num } from './num.mjs'

function pick(obj, ...keys) {
  if (!obj || typeof obj !== 'object') return undefined
  for (const key of keys) {
    if (obj[key] != null && obj[key] !== '') return obj[key]
  }
  return undefined
}

function unwrap(raw) {
  if (!raw || typeof raw !== 'object') return raw
  if (raw.vault) return unwrap(raw.vault)
  if (raw.loan_broker) return unwrap(raw.loan_broker)
  if (raw.loan) return unwrap(raw.loan)
  if (raw.node) return unwrap(raw.node)
  if (raw.result) return unwrap(raw.result)
  return raw
}

/** `vault_info` → VaultSnapshot (accepte aussi notre forme camelCase). */
export function adaptVault(raw) {
  const v = unwrap(raw)
  const shares = unwrap(v?.shares, 'shares') ?? v
  return {
    vaultId: String(pick(v, 'vaultId', 'index', 'VaultID') ?? ''),
    account: pick(v, 'account', 'Account'),
    owner: pick(v, 'owner', 'Owner'),
    assetsTotal: pick(v, 'assetsTotal', 'AssetsTotal'),
    assetsAvailable: pick(v, 'assetsAvailable', 'AssetsAvailable'),
    lossUnrealized: pick(v, 'lossUnrealized', 'LossUnrealized'),
    shareMptId: pick(v, 'shareMptId', 'ShareMPTID', 'shareMPTID'),
    sharesOutstanding: pick(shares, 'sharesOutstanding', 'OutstandingAmount'),
    vaultKind: num(pick(v, 'vaultKind', 'VaultKind'), 0),
    subscriptionDate: num(pick(v, 'subscriptionDate', 'SubscriptionDate'), 0),
    redemptionDate: num(pick(v, 'redemptionDate', 'RedemptionDate'), 0),
    scale: num(pick(v, 'scale', 'Scale'), 0),
    flags: num(pick(v, 'flags', 'Flags'), 0),
  }
}

/** `ledger_entry` LoanBroker → LoanBrokerSnapshot. */
export function adaptBroker(raw) {
  const b = unwrap(raw)
  return {
    loanBrokerId: String(pick(b, 'loanBrokerId', 'index', 'LoanBrokerID') ?? ''),
    vaultId: pick(b, 'vaultId', 'VaultID'),
    account: pick(b, 'account', 'Account'),
    owner: pick(b, 'owner', 'Owner'),
    debtTotal: pick(b, 'debtTotal', 'DebtTotal'),
    debtMaximum: pick(b, 'debtMaximum', 'DebtMaximum'),
    coverAvailable: pick(b, 'coverAvailable', 'CoverAvailable'),
    coverRateMinimum: num(pick(b, 'coverRateMinimum', 'CoverRateMinimum'), 0),
    coverRateLiquidation: num(pick(b, 'coverRateLiquidation', 'CoverRateLiquidation'), 0),
    managementFeeRate: num(pick(b, 'managementFeeRate', 'ManagementFeeRate'), 0),
    ownerCount: num(pick(b, 'ownerCount', 'OwnerCount'), 0),
    loanSequence: num(pick(b, 'loanSequence', 'LoanSequence'), 0),
    didVerified: Boolean(pick(b, 'didVerified')),
  }
}

/** `ledger_entry` Loan → LoanSnapshot. */
export function adaptLoan(raw) {
  const l = unwrap(raw)
  return {
    loanId: String(pick(l, 'loanId', 'index', 'LoanID') ?? ''),
    loanBrokerId: pick(l, 'loanBrokerId', 'LoanBrokerID'),
    loanSequence: num(pick(l, 'loanSequence', 'LoanSequence'), 0),
    borrower: pick(l, 'borrower', 'Borrower'),
    principalOutstanding: pick(l, 'principalOutstanding', 'PrincipalOutstanding'),
    totalValueOutstanding: pick(l, 'totalValueOutstanding', 'TotalValueOutstanding'),
    managementFeeOutstanding: pick(l, 'managementFeeOutstanding', 'ManagementFeeOutstanding'),
    periodicPayment: pick(l, 'periodicPayment', 'PeriodicPayment'),
    paymentRemaining: num(pick(l, 'paymentRemaining', 'PaymentRemaining'), 0),
    nextPaymentDueDate: num(pick(l, 'nextPaymentDueDate', 'NextPaymentDueDate'), 0),
    gracePeriod: num(pick(l, 'gracePeriod', 'GracePeriod'), 0),
    startDate: num(pick(l, 'startDate', 'StartDate'), 0),
    interestRate: num(pick(l, 'interestRate', 'InterestRate'), 0),
    flags: num(pick(l, 'flags', 'Flags'), 0),
  }
}

export function adaptLoans(list = []) {
  return list.map(adaptLoan)
}

/**
 * Normalise un monde (dump Hugo ou fixtures) vers les args de `analyzeOffer`.
 */
export function adaptCase(input) {
  return {
    vault: adaptVault(input.vault),
    broker: adaptBroker(input.broker),
    loans: adaptLoans(input.loans ?? []),
    offer: input.offer ?? { shares: 0, discount: 0 },
    nowRipple: num(input.nowRipple, 0),
    stressRate: num(input.stressRate, 0),
  }
}
