/** Unités de taux on-chain : 1 = 0,001 % = 1/10 de basis point. 100_000 = 100 %. */
export const TENTH_BPS = 100_000

/** `ManagementFeeRate` est capé à 10 % (10_000 dixièmes de bps). */
export const MANAGEMENT_FEE_RATE_MAX = 10_000

/** Gap min Closed-Ended : RedemptionDate − SubscriptionDate ≥ 180 s. */
export const MIN_INVESTMENT_PERIOD = 180

/** Dernière échéance d'un prêt ≥ 60 s avant RedemptionDate. */
export const LOAN_REDEMPTION_BUFFER = 60

export const VaultKind = Object.freeze({
  OpenEnded: 0,
  ClosedEnded: 1,
})

export const VaultPhase = Object.freeze({
  NoPhase: 'NoPhase',
  Subscription: 'Subscription',
  Investment: 'Investment',
  Redemption: 'Redemption',
})

/** Flags ledger `Loan` (XLS-66). */
export const LoanFlags = Object.freeze({
  lsfLoanDefault: 0x0001_0000,
  lsfLoanImpaired: 0x0002_0000,
  lsfLoanOverpayment: 0x0004_0000,
})

/** Poids RiskLens (somme = 1). */
export const ScoreWeights = Object.freeze({
  flcr: 0.35,
  npl: 0.25,
  concentration: 0.2,
  liquidity: 0.1,
  did: 0.1,
})

export const RatingBands = Object.freeze([
  ['AAA', 85],
  ['AA', 75],
  ['A', 65],
  ['BBB', 55],
  ['BB', 45],
  ['B', 35],
  ['CCC', 25],
  ['CC', 15],
  ['C', 5],
])
