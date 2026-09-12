/**
 * @secondwave/vault/rules — les règles XLS-65/66 encodées, avec leurs unités.
 *
 * ⚠️ Ce fichier est le produit direct de la campagne de sonde du 12/09/2026.
 *    CHAQUE règle ici a été établie empiriquement sur le Devnet parce que la
 *    documentation est absente ou fausse. Le renvoi entre crochets pointe le cas
 *    de `probes/RESULTATS.md` qui l'a démontrée. Le protocole, lui, rejette la
 *    plupart de ces violations par un `temMALFORMED` / `temINVALID` **nu**, sans
 *    nommer le champ : tout l'intérêt de ce module est de rendre le message.
 *
 * Aucune de ces fonctions ne touche le réseau : elles sont testables hors ligne
 * (voir packages/vault/test/rules.test.mjs).
 */

// ─────────────────────────────────────────────────────────────
// L'erreur : code court, message factuel (avec la valeur reçue), remède actionnable
// ─────────────────────────────────────────────────────────────
export class VaultError extends Error {
  constructor(code, message, remede = '') {
    super(remede ? `${message} — remède : ${remede}` : message)
    this.name = 'VaultError'
    this.code = code          // ex. 'GRACE_PERIOD_RANGE'
    this.detail = message     // le fait, sans le remède
    this.remede = remede      // ce qu'il faut faire
  }
}
const fail = (code, message, remede) => { throw new VaultError(code, message, remede) }

// ─────────────────────────────────────────────────────────────
// Les unités — introuvables dans toute doc, mesurées au drop près.
// ─────────────────────────────────────────────────────────────
/** Écart imposé RedemptionDate − SubscriptionDate. [A-6 : 179 refusé, 180 accepté] */
export const MIN_PHASE_GAP = 180
/** Plafond du même écart. [A-7 : 30 ans acceptés, 31 refusés] */
export const MAX_PHASE_GAP = 946708560            // ~30,02 ans (borne exclusive)

/** Un LoanSet est refusé si sa dernière échéance tombe trop près de RedemptionDate.
 *  Le protocole exige ~60 s [F-69], mais la borne est mesurée en **temps ledger**
 *  (close time parente, résolution 10 s) : à l'horloge murale il faut ~90 s [X2]. */
export const LOAN_END_MARGIN_MIN = 60             // plancher protocole
export const LOAN_END_MARGIN_SAFE = 90            // marge sûre à l'horloge murale

/** Bornes de l'échéancier d'un prêt. [F : 60 ≤ GracePeriod ≤ PaymentInterval] */
export const MIN_PAYMENT_INTERVAL = 60
export const MIN_GRACE_PERIOD = 60

/** InterestRate : ANNUALISÉ, en 1/100 000. [F-72 : 10 XRP à 100000 ⇒ 64 drops sur 200 s] */
export const INTEREST_RATE_DENOMINATOR = 100000
export const SECONDS_PER_YEAR = 31536000
/** 2^32−1 échoue [F-72]; la vraie borne haute est inconnue, on refuse au moins ça. */
export const INTEREST_RATE_MAX = 4294967294

/** CoverRate : ratios instantanés en 1/100 000. [E-55] */
export const COVER_RATE_DENOMINATOR = 100000
/** ManagementFeeRate : en 1/100 000, plafonné à 10 % . [E-59 : > 10000 refusé] */
export const MANAGEMENT_FEE_DENOMINATOR = 100000
export const MANAGEMENT_FEE_MAX = 10000

/** Scale : interdit sur XRP/MPT, 0..18 sur IOU. [A-8/9/10] */
export const SCALE_MAX_IOU = 18
/** Data : hex pair, 1..256 octets. [A-13] */
export const DATA_MAX_BYTES = 256
/** WithdrawalPolicy : seule la valeur 1 existe. [A-12] */
export const WITHDRAWAL_POLICIES = [1]
/** AcceptedCredentials d'un domaine : 10 max. [D-46] */
export const ACCEPTED_CREDENTIALS_MAX = 10
/** Flags VaultCreate (rappel). */
export const TF_VAULT_PRIVATE = 0x00010000
export const TF_VAULT_SHARE_NON_TRANSFERABLE = 0x00020000

// ─────────────────────────────────────────────────────────────
// Les formules dérivées — pour l'analyste, documentées ici une fois pour toutes.
// ─────────────────────────────────────────────────────────────
/** Intérêt total (drops) d'un principal sur une durée, au taux annualisé. [F-72] */
export function interestOver(principalDrops, ratePer1e5, seconds) {
  return (BigInt(principalDrops) * BigInt(ratePer1e5) * BigInt(seconds))
    / (BigInt(INTEREST_RATE_DENOMINATOR) * BigInt(SECONDS_PER_YEAR))
}

/** Cover EXIGÉ pour couvrir une dette, au taux minimum. [E-55 : required = dette × min/1e5] */
export function coverRequired(debtDrops, coverRateMinimum) {
  return (BigInt(debtDrops) * BigInt(coverRateMinimum)) / BigInt(COVER_RATE_DENOMINATOR)
}

/** Ce que le cover rembourse AU MOMENT du défaut. [G-85 : ponction = principal × min × liq / 1e5²]
 *  ⚠️ Ce n'est PAS min(cover, perte) : avec les taux par défaut 10000/50000 la
 *     protection réelle n'est que de 5 % du principal, cover disponible ignoré. */
export function coverPayoutAtDefault(principalDrops, coverRateMinimum, coverRateLiquidation) {
  return (BigInt(principalDrops) * BigInt(coverRateMinimum) * BigInt(coverRateLiquidation))
    / (BigInt(COVER_RATE_DENOMINATOR) * BigInt(COVER_RATE_DENOMINATOR))
}

// ─────────────────────────────────────────────────────────────
// Les validateurs — appelés AVANT tout envoi réseau. Chacun jette un VaultError.
// ─────────────────────────────────────────────────────────────
const isInt = n => Number.isInteger(n)

/** VaultCreate closed-ended : les deux dates, l'écart dans [180, ~30 ans). [A-2/3/5/6/7] */
export function assertVaultDates({ subscriptionDate, redemptionDate }) {
  if (subscriptionDate == null || redemptionDate == null)
    fail('CLOSED_DATES_REQUIRED',
      `un vault closed-ended (VaultKind:1) exige SubscriptionDate ET RedemptionDate (reçu sub=${subscriptionDate}, red=${redemptionDate})`,
      'fournir les deux dates, ou omettre VaultKind pour un vault open-ended')
  const gap = Number(redemptionDate) - Number(subscriptionDate)
  if (gap < MIN_PHASE_GAP || gap >= MAX_PHASE_GAP)
    fail('PHASE_GAP_RANGE',
      `l'écart RedemptionDate − SubscriptionDate vaut ${gap}s ; il doit être dans [${MIN_PHASE_GAP}, ${MAX_PHASE_GAP}) secondes`,
      `viser un écart ≥ ${MIN_PHASE_GAP}s (et < ~30 ans)`)
}

/** Scale : refusé sur XRP/MPT, borné sur IOU. [A-8/9/10] */
export function assertScale(asset, scale) {
  if (scale == null) return
  const isIou = asset && asset.currency && asset.currency !== 'XRP' && asset.issuer
  if (!isIou)
    fail('SCALE_FORBIDDEN',
      `Scale (${scale}) n'est autorisé que pour un actif IOU ; l'actif ici est ${asset?.mpt_issuance_id ? 'un MPT' : 'XRP'}`,
      'retirer le champ Scale pour un vault XRP ou MPT')
  if (!isInt(scale) || scale < 0 || scale > SCALE_MAX_IOU)
    fail('SCALE_RANGE',
      `Scale vaut ${scale} ; sur un IOU il doit être un entier dans [0, ${SCALE_MAX_IOU}]`,
      `choisir un Scale entre 0 et ${SCALE_MAX_IOU}`)
}

/** WithdrawalPolicy : seule 1 existe. [A-12] */
export function assertWithdrawalPolicy(p) {
  if (p == null) return
  if (!WITHDRAWAL_POLICIES.includes(p))
    fail('WITHDRAWAL_POLICY',
      `WithdrawalPolicy vaut ${p} ; seule la valeur ${WITHDRAWAL_POLICIES.join('/')} (first-come-first-served) existe`,
      'utiliser WithdrawalPolicy: 1')
}

/** Data : hex pair, 1..256 octets. [A-13] · vaut aussi pour Broker.Data. */
export function assertDataHex(dataHex, field = 'Data') {
  if (dataHex == null) return
  if (typeof dataHex !== 'string' || dataHex.length === 0 || dataHex.length % 2 !== 0)
    fail('DATA_MALFORMED',
      `${field} doit être une chaîne hex non vide et de longueur paire (reçu ${JSON.stringify(dataHex)})`,
      'encoder en hex (Buffer.from(x).toString("hex")) et ne pas envoyer une chaîne vide')
  const bytes = dataHex.length / 2
  if (bytes > DATA_MAX_BYTES)
    fail('DATA_TOO_LONG',
      `${field} fait ${bytes} octets ; la limite est ${DATA_MAX_BYTES}`,
      `tronquer à ${DATA_MAX_BYTES} octets`)
}

/** DomainID impose tfVaultPrivate. [A-17] */
export function assertDomainFlag({ domainId, flags }) {
  if (domainId && !((flags ?? 0) & TF_VAULT_PRIVATE))
    fail('DOMAIN_NEEDS_PRIVATE',
      'DomainID est fourni sans le flag tfVaultPrivate ; le domaine ne serait pas appliqué',
      'ajouter Flags: VAULT_FLAGS.PRIVATE en présence d\'un DomainID')
}

/** CoverRate : les deux nuls ou les deux non nuls. [E-51/52] */
export function assertCoverRates({ coverRateMinimum, coverRateLiquidation }) {
  const min = Number(coverRateMinimum ?? 0)
  const liq = Number(coverRateLiquidation ?? 0)
  if ((min === 0) !== (liq === 0))
    fail('COVER_RATES_PAIRED',
      `CoverRateMinimum (${min}) et CoverRateLiquidation (${liq}) doivent être tous deux nuls ou tous deux non nuls`,
      'mettre les deux à 0 (broker sans first-loss capital) ou les deux à une valeur > 0')
}

/** ManagementFeeRate ∈ [0, 10000]. [E-59] */
export function assertManagementFee(rate) {
  if (rate == null) return
  if (!isInt(rate) || rate < 0 || rate > MANAGEMENT_FEE_MAX)
    fail('MANAGEMENT_FEE_RANGE',
      `ManagementFeeRate vaut ${rate} ; il doit être un entier dans [0, ${MANAGEMENT_FEE_MAX}] (soit 0 à 10 %)`,
      `plafonner à ${MANAGEMENT_FEE_MAX}`)
}

/** Les CoverRate et le ManagementFeeRate sont IMMUABLES après création. [X1/Y2] */
export function assertBrokerUpdateAllowed(fields) {
  const bloques = ['coverRateMinimum', 'coverRateLiquidation', 'managementFeeRate']
    .filter(k => k in fields)
  if (bloques.length)
    fail('BROKER_FIELD_IMMUTABLE',
      `ces champs d'un LoanBroker sont immuables après création : ${bloques.join(', ')}`,
      'seuls DebtMaximum et Data sont modifiables ; recréer un broker pour changer les taux')
}

/** L'échéancier d'un LoanSet : 60 ≤ GracePeriod ≤ PaymentInterval, PaymentTotal ≥ 1.
 *  ⚠️ LA règle non documentée qui rejette en `temINVALID` nu. [F : g-sweep] */
export function assertLoanSchedule({ paymentInterval, paymentTotal, gracePeriod }) {
  if (!isInt(paymentInterval) || paymentInterval < MIN_PAYMENT_INTERVAL)
    fail('PAYMENT_INTERVAL_MIN',
      `PaymentInterval vaut ${paymentInterval} ; il doit être un entier ≥ ${MIN_PAYMENT_INTERVAL}s`,
      `viser au moins ${MIN_PAYMENT_INTERVAL}s`)
  if (!isInt(paymentTotal) || paymentTotal < 1)
    fail('PAYMENT_TOTAL_MIN',
      `PaymentTotal vaut ${paymentTotal} ; il doit être un entier ≥ 1`,
      'au moins une échéance')
  if (!isInt(gracePeriod) || gracePeriod < MIN_GRACE_PERIOD || gracePeriod > paymentInterval)
    fail('GRACE_PERIOD_RANGE',
      `GracePeriod vaut ${gracePeriod} ; la règle (non documentée) est ${MIN_GRACE_PERIOD} ≤ GracePeriod ≤ PaymentInterval (=${paymentInterval})`,
      `choisir GracePeriod entre ${MIN_GRACE_PERIOD} et ${paymentInterval}`)
}

/** InterestRate : entier ≥ 0, sous la borne haute. [F-72] */
export function assertInterestRate(rate) {
  if (rate == null) return
  if (!isInt(rate) || rate < 0 || rate > INTEREST_RATE_MAX)
    fail('INTEREST_RATE_RANGE',
      `InterestRate vaut ${rate} ; il doit être un entier dans [0, ${INTEREST_RATE_MAX}] (annualisé, 1/100 000)`,
      'un taux de 5 %/an s\'écrit 5000 ; 50 % ⇒ 50000')
}

/** StartDate et Data sont interdits sur LoanSet. [F-74 rejet · F-75 accepté puis JETÉ] */
export function assertNoForbiddenLoanFields({ startDate, data }) {
  if (startDate != null)
    fail('LOANSET_STARTDATE',
      'StartDate n\'est pas un champ de la transaction LoanSet (il est dérivé sur l\'objet Loan)',
      'ne pas envoyer StartDate ; il vaudra la date de création')
  if (data != null)
    fail('LOANSET_DATA_DROPPED',
      'Data est accepté par la validation de LoanSet puis SILENCIEUSEMENT jeté (absent de l\'objet Loan)',
      'ne rien stocker dans Data sur un LoanSet ; utiliser un registre hors-chaîne')
}

/** La dernière échéance doit tomber avant RedemptionDate, avec marge sûre. [F-69/X2] */
export function assertLoanEndsBeforeRedemption({ paymentInterval, paymentTotal, redemptionDate, at }) {
  if (redemptionDate == null) return   // pas d'info : on ne peut pas vérifier localement
  const lastDue = at + paymentInterval * paymentTotal
  const margin = Number(redemptionDate) - lastDue
  if (margin < LOAN_END_MARGIN_SAFE)
    fail('LOAN_END_MARGIN',
      `la dernière échéance tombe à ${margin}s de RedemptionDate ; il faut ~${LOAN_END_MARGIN_SAFE}s de marge `
      + `(le protocole dit ${LOAN_END_MARGIN_MIN}s mais la mesure est en temps ledger)`,
      `raccourcir PaymentInterval×PaymentTotal (=${paymentInterval * paymentTotal}s) ou éloigner RedemptionDate`)
}
