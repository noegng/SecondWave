/**
 * Contrat d'interface SecondWave.
 *
 * Hugo remplit les lecteurs ledger (`vault_info`, `account_objects`, …) et
 * produit ces formes. Noé (`@secondwave/analyst`) les consomme — aucun
 * aller-retour Devnet requis pour tester le moteur.
 *
 * Les montants XRPL arrivent souvent en string : l'analyste normalise.
 */

/**
 * @typedef {object} VaultSnapshot
 * @property {string} vaultId
 * @property {string} [account]            pseudo-compte du vault
 * @property {string} [owner]
 * @property {string|number} [assetsTotal]
 * @property {string|number} [assetsAvailable]
 * @property {string|number} [lossUnrealized]
 * @property {string} [shareMptId]
 * @property {string|number} [sharesOutstanding]  MPTokenIssuance.OutstandingAmount
 * @property {number} [vaultKind]           0 open / 1 closed
 * @property {number} [subscriptionDate]    Ripple epoch (s)
 * @property {number} [redemptionDate]      Ripple epoch (s)
 * @property {number} [scale]
 * @property {number} [flags]
 */

/**
 * @typedef {object} LoanBrokerSnapshot
 * @property {string} loanBrokerId
 * @property {string} [vaultId]
 * @property {string} [account]             pseudo-compte du broker
 * @property {string} [owner]
 * @property {string|number} [debtTotal]
 * @property {string|number} [debtMaximum]
 * @property {string|number} [coverAvailable]
 * @property {number} [coverRateMinimum]    1/10 bps, 0–100_000
 * @property {number} [coverRateLiquidation]
 * @property {number} [managementFeeRate]   1/10 bps, 0–10_000
 * @property {number} [ownerCount]
 * @property {number} [loanSequence]
 * @property {boolean} [didVerified]
 */

/**
 * @typedef {object} LoanSnapshot
 * @property {string} [loanId]
 * @property {string} [loanBrokerId]
 * @property {number} [loanSequence]
 * @property {string} [borrower]
 * @property {string|number} [principalOutstanding]
 * @property {string|number} [totalValueOutstanding]
 * @property {string|number} [managementFeeOutstanding]
 * @property {string|number} [periodicPayment]
 * @property {number} [paymentRemaining]
 * @property {number} [nextPaymentDueDate]  Ripple epoch (s)
 * @property {number} [gracePeriod]         secondes
 * @property {number} [startDate]
 * @property {number} [interestRate]        1/10 bps
 * @property {number} [flags]
 */

/**
 * @typedef {object} OfferQuote
 * @property {string|number} shares
 * @property {number} discount              0–1 (0,03 = 3 %)
 * @property {string|number} [price]        prix demandé ; sinon NAV × shares × (1 − discount)
 */

export {}
