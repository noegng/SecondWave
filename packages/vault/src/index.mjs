/**
 * @secondwave/vault — le cycle de vie XLS-65 / XLS-66.
 *
 * Chaque helper renvoie le résultat de `submit()` de core, enrichi de l'ID de
 * l'objet créé quand il y en a un. Aucun ne lève : on lit `.ok` et `.result`.
 */
import {
  submit, submitLoanSet, createdIndex, readVault, rippleNow, sleep,
  VAULT_FLAGS, MANAGE_FLAGS,
} from '@secondwave/core'
import {
  VaultError,
  MIN_PHASE_GAP, MAX_PHASE_GAP, LOAN_END_MARGIN_MIN, LOAN_END_MARGIN_SAFE,
  assertVaultDates, assertScale, assertWithdrawalPolicy, assertDataHex, assertDomainFlag,
  assertCoverRates, assertManagementFee, assertBrokerUpdateAllowed,
  assertLoanSchedule, assertInterestRate, assertNoForbiddenLoanFields,
  assertLoanEndsBeforeRedemption,
} from './rules.mjs'

export const hex = s => Buffer.from(s, 'utf8').toString('hex').toUpperCase()

// Les règles et leurs unités vivent dans rules.mjs (testable hors ligne). On les
// ré-exporte pour que settlement/analyste/CLI y accèdent via @secondwave/vault.
export * from './rules.mjs'
/** Alias historique — le plancher protocole de la marge de fin de prêt. */
export const LOAN_END_MARGIN = LOAN_END_MARGIN_MIN

// ─────────────────────────────────────────────────────────────
// P1.1 — Identité
// ─────────────────────────────────────────────────────────────
/**
 * ⚠️ Les deux transactions sont nécessaires : un credential émis mais jamais
 * accepté n'ouvre aucun domaine (le bit lsfAccepted reste à zéro).
 */
export async function issueCredential(client, { issuer, subject, type = 'KYC', expiration }) {
  const create = await submit(client, {
    TransactionType: 'CredentialCreate',
    Account: issuer.classicAddress,
    Subject: subject.classicAddress,
    CredentialType: hex(type),
    ...(expiration ? { Expiration: expiration } : {}),
  }, issuer)
  if (!create.ok) return create

  const accept = await submit(client, {
    TransactionType: 'CredentialAccept',
    Account: subject.classicAddress,
    Issuer: issuer.classicAddress,
    CredentialType: hex(type),
  }, subject)
  return accept
}

/**
 * Émet un credential sans l'accepter — pour un wallet externe (extension)
 * dont on n'a pas la seed. Le sujet doit ensuite soumettre `CredentialAccept`.
 */
export function createCredential(client, { issuer, subject, type = 'KYC', expiration }) {
  const address = typeof subject === 'string' ? subject : subject.classicAddress
  return submit(client, {
    TransactionType: 'CredentialCreate',
    Account: issuer.classicAddress,
    Subject: address,
    CredentialType: hex(type),
    ...(expiration ? { Expiration: expiration } : {}),
  }, issuer)
}

export async function createDomain(client, { owner, issuer, type = 'KYC' }) {
  const r = await submit(client, {
    TransactionType: 'PermissionedDomainSet',
    Account: owner.classicAddress,
    AcceptedCredentials: [{ Credential: { Issuer: issuer.classicAddress, CredentialType: hex(type) } }],
  }, owner)
  return { ...r, domainId: createdIndex(r, 'PermissionedDomain') }
}

// ─────────────────────────────────────────────────────────────
// P1.2 — Vault
// ─────────────────────────────────────────────────────────────
/**
 * Vault closed-ended. `subscriptionIn` et `investmentFor` sont des secondes
 * relatives à maintenant — les dates d'un hackathon sont compressées.
 *
 * ⚠️ `Scale` est refusé (temMALFORMED) pour XRP et pour un actif MPT.
 * ⚠️ `domainId` implique `Flags: tfVaultPrivate` — sinon le gate ne s'applique pas.
 */
export async function createVault(client, owner, {
  asset = { currency: 'XRP' },
  subscriptionIn = 90,
  investmentFor = 600,
  assetsMaximum = '0',
  domainId = null,
  scale = null,
  withdrawalPolicy = 1,
  data = null,
  shareNonTransferable = false,
} = {}) {
  const subscriptionDate = rippleNow() + subscriptionIn
  const redemptionDate = subscriptionDate + investmentFor
  const dataHex = data ? hex(data) : null
  const flags = (domainId ? VAULT_FLAGS.PRIVATE : 0)
    | (shareNonTransferable ? VAULT_FLAGS.SHARES_NON_TRANSFERABLE : 0)

  // Validation locale AVANT le réseau : plus jamais un temMALFORMED nu. [voir rules.mjs]
  assertVaultDates({ subscriptionDate, redemptionDate })
  assertScale(asset, scale)
  assertWithdrawalPolicy(withdrawalPolicy)
  assertDataHex(dataHex)
  assertDomainFlag({ domainId, flags })

  const r = await submit(client, {
    TransactionType: 'VaultCreate',
    Account: owner.classicAddress,
    Asset: asset,
    AssetsMaximum: assetsMaximum,
    VaultKind: 1,
    SubscriptionDate: subscriptionDate,
    RedemptionDate: redemptionDate,
    WithdrawalPolicy: withdrawalPolicy,
    ...(flags ? { Flags: flags } : {}),
    ...(domainId ? { DomainID: domainId } : {}),
    ...(scale != null ? { Scale: scale } : {}),
    ...(dataHex ? { Data: dataHex } : {}),
  }, owner)

  const vaultId = createdIndex(r, 'Vault')
  const vault = vaultId ? await readVault(client, vaultId) : null
  return { ...r, vaultId, vault, mptId: vault?.ShareMPTID, subscriptionDate, redemptionDate }
}

/** Bloque jusqu'à l'ouverture de la phase Investment (+ une marge de sécurité). */
export async function waitForInvestment(vault, margin = 10) {
  const wait = Number(vault.SubscriptionDate) - rippleNow() + margin
  if (wait > 0) await sleep(wait * 1000)
  return wait > 0 ? wait : 0
}

/** Idem pour la phase Redemption. */
export async function waitForRedemption(vault, margin = 10) {
  const wait = Number(vault.RedemptionDate) - rippleNow() + margin
  if (wait > 0) await sleep(wait * 1000)
  return wait > 0 ? wait : 0
}

// ─────────────────────────────────────────────────────────────
// P1.3 — Dépôts et retraits
// ─────────────────────────────────────────────────────────────
/** ⚠️ Hors phase Subscription : `tecTOO_SOON`. Non-membre du domaine : `tecNO_AUTH`. */
export function deposit(client, depositor, vaultId, amount) {
  return submit(client, {
    TransactionType: 'VaultDeposit',
    Account: depositor.classicAddress,
    VaultID: vaultId,
    Amount: amount,
  }, depositor)
}

/** Le montant est libellé en PARTS, pas en actif sous-jacent. */
export function withdraw(client, holder, vaultId, mptId, shares) {
  return submit(client, {
    TransactionType: 'VaultWithdraw',
    Account: holder.classicAddress,
    VaultID: vaultId,
    Amount: { mpt_issuance_id: mptId, value: String(shares) },
  }, holder)
}

// ─────────────────────────────────────────────────────────────
// P1.4 — Brokers et first-loss capital
// ─────────────────────────────────────────────────────────────
/**
 * ⚠️ Sous LendingProtocolV1_1 le vault DOIT être closed-ended → sinon `tecNO_PERMISSION`.
 * ⚠️ `CoverRateMinimum` et `CoverRateLiquidation` : les deux nuls ou les deux non
 *    nuls, et **immuables** après création. Zéro/zéro est légal — donc un broker
 *    peut légitimement n'apporter aucune garantie. L'analyste doit le signaler.
 */
export async function createBroker(client, owner, vaultId, {
  debtMaximum = '0',
  coverRateMinimum = 10000,
  coverRateLiquidation = 50000,
  managementFeeRate = 1000,
  data = null,
} = {}) {
  const dataHex = data ? hex(data) : null
  assertCoverRates({ coverRateMinimum, coverRateLiquidation })
  assertManagementFee(managementFeeRate)
  assertDataHex(dataHex, 'Broker.Data')

  const r = await submit(client, {
    TransactionType: 'LoanBrokerSet',
    Account: owner.classicAddress,
    VaultID: vaultId,
    DebtMaximum: debtMaximum,
    CoverRateMinimum: coverRateMinimum,
    CoverRateLiquidation: coverRateLiquidation,
    ManagementFeeRate: managementFeeRate,
    ...(dataHex ? { Data: dataHex } : {}),
  }, owner)
  return { ...r, brokerId: createdIndex(r, 'LoanBroker') }
}

/**
 * Modifie un broker existant. ⚠️ Seuls DebtMaximum et Data sont mutables ;
 * CoverRate* et ManagementFeeRate sont immuables [X1/Y2]. Le SDK exige VaultID
 * même pour un update [E-54], on le passe donc explicitement.
 */
export async function updateBroker(client, owner, vaultId, brokerId, fields = {}) {
  assertBrokerUpdateAllowed(fields)
  const dataHex = fields.data ? hex(fields.data) : null
  assertDataHex(dataHex, 'Broker.Data')
  const r = await submit(client, {
    TransactionType: 'LoanBrokerSet',
    Account: owner.classicAddress,
    VaultID: vaultId,
    LoanBrokerID: brokerId,
    ...(fields.debtMaximum != null ? { DebtMaximum: String(fields.debtMaximum) } : {}),
    ...(dataHex ? { Data: dataHex } : {}),
  }, owner)
  return { ...r, brokerId }
}

export function coverDeposit(client, owner, brokerId, amount) {
  return submit(client, {
    TransactionType: 'LoanBrokerCoverDeposit',
    Account: owner.classicAddress,
    LoanBrokerID: brokerId,
    Amount: amount,
  }, owner)
}

/** ⚠️ Quand `DebtTotal = 0`, le broker peut retirer **100 %** du cover. */
export function coverWithdraw(client, owner, brokerId, amount) {
  return submit(client, {
    TransactionType: 'LoanBrokerCoverWithdraw',
    Account: owner.classicAddress,
    LoanBrokerID: brokerId,
    Amount: amount,
  }, owner)
}

// ─────────────────────────────────────────────────────────────
// P1.5 — Prêts
// ─────────────────────────────────────────────────────────────
/**
 * ⚠️ La dernière échéance (`PaymentInterval × PaymentTotal`) doit tomber au
 *    moins ~60 s avant `RedemptionDate`, sinon `tecEXPIRED`.
 * ⚠️ `StartDate` n'est pas un champ de LoanSet (dérivé sur l'objet Loan).
 * ⚠️ `Data` est accepté par la validation puis jeté — ne rien y stocker.
 * ⚠️ La co-signature passe par le fix `CPT\0` (voir core.counterpartySign).
 */
export async function createLoan(client, borrower, brokerOwner, brokerId, {
  principal,
  paymentInterval = 60,
  paymentTotal = 2,
  gracePeriod = 60,
  interestRate = 50000,
  originationFee = null,
  serviceFee = null,
  latePaymentFee = null,
  redemptionDate = null,   // optionnel : active la vérification de marge de fin [F-69]
} = {}) {
  // Validation locale AVANT le réseau — dont la règle 60 ≤ grace ≤ interval,
  // qui sinon sort en `temINVALID` nu. [voir rules.mjs / probes/RESULTATS.md §F]
  assertLoanSchedule({ paymentInterval, paymentTotal, gracePeriod })
  assertInterestRate(interestRate)
  assertNoForbiddenLoanFields({ startDate: undefined, data: undefined })
  assertLoanEndsBeforeRedemption({ paymentInterval, paymentTotal, redemptionDate, at: rippleNow() })

  const r = await submitLoanSet(client, {
    TransactionType: 'LoanSet',
    Account: borrower.classicAddress,
    LoanBrokerID: brokerId,
    PrincipalRequested: String(principal),
    PaymentInterval: paymentInterval,
    PaymentTotal: paymentTotal,
    GracePeriod: gracePeriod,
    InterestRate: interestRate,
    ...(originationFee ? { LoanOriginationFee: String(originationFee) } : {}),
    ...(serviceFee ? { LoanServiceFee: String(serviceFee) } : {}),
    ...(latePaymentFee ? { LatePaymentFee: String(latePaymentFee) } : {}),
  }, borrower, brokerOwner)
  return { ...r, loanId: createdIndex(r, 'Loan') }
}

/**
 * ⚠️ La fenêtre de paiement se ferme À l'échéance : après `NextPaymentDueDate`,
 *    un LoanPay nu sort en `tecEXPIRED` [F-77]. Pour un paiement en retard il
 *    faut poser `flags = 0x00040000` (tfLoanLatePayment). Sur-payer exige
 *    `tfLoanOverpayment` (0x00010000), possible seulement si le prêt le permet.
 */
export function payLoan(client, borrower, loanId, amount, flags = 0) {
  return submit(client, {
    TransactionType: 'LoanPay',
    Account: borrower.classicAddress,
    LoanID: loanId,
    Amount: String(amount),
    ...(flags ? { Flags: flags } : {}),
  }, borrower)
}

/** Supprime un objet Loan soldé (TVO absent). ⚠️ à faire par l'EMPRUNTEUR [F-80]. */
export function deleteLoan(client, borrower, loanId) {
  return submit(client, {
    TransactionType: 'LoanDelete',
    Account: borrower.classicAddress,
    LoanID: loanId,
  }, borrower)
}

/**
 * Remboursement anticipé intégral — mesuré en Z4 (annexe Z de RESULTATS) :
 *   · sans flag : `Amount ≥ TotalValueOutstanding` solde le prêt, débit = TVO exact ;
 *   · avec `tfLoanFullPayment` : solde en ne débitant QUE le principal (intérêt couru remis).
 * ⚠️ En DERNIÈRE période (`PaymentRemaining = 1`) le solde anticipé sort en
 *    `tecKILLED` — il ne reste alors qu'à payer l'échéance normalement.
 */
export async function settleLoan(client, borrower, loanId, { waiveInterest = false } = {}) {
  const r = await client.request({ command: 'ledger_entry', index: loanId, ledger_index: 'validated' })
  const tvo = r.result.node?.TotalValueOutstanding
  if (tvo == null) return { ok: true, result: 'déjà soldé', alreadySettled: true }
  return submit(client, {
    TransactionType: 'LoanPay',
    Account: borrower.classicAddress,
    LoanID: loanId,
    Amount: String(tvo),
    ...(waiveInterest ? { Flags: 0x00020000 /* tfLoanFullPayment */ } : {}),
  }, borrower)
}

/** `tfLoanImpair` constate une perte latente · `tfLoanDefault` ponctionne le cover. */
export function manageLoan(client, brokerOwner, loanId, flag) {
  return submit(client, {
    TransactionType: 'LoanManage',
    Account: brokerOwner.classicAddress,
    LoanID: loanId,
    Flags: flag,
  }, brokerOwner)
}

export const impair = (c, w, id) => manageLoan(c, w, id, MANAGE_FLAGS.IMPAIR)
export const unimpair = (c, w, id) => manageLoan(c, w, id, MANAGE_FLAGS.UNIMPAIR)
export const declareDefault = (c, w, id) => manageLoan(c, w, id, MANAGE_FLAGS.DEFAULT)
