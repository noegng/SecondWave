import {
  TENTH_BPS,
  VaultKind,
  VaultPhase,
  LoanFlags,
} from '@secondwave/core'
import { num } from './num.mjs'

/** Convertit un taux 1/10 bps en ratio (500 → 0,005). */
export function tenthBpsToRatio(tenthBps) {
  return num(tenthBps) / TENTH_BPS
}

export function ratioToTenthBps(ratio) {
  return Math.round(num(ratio) * TENTH_BPS)
}

export function hasFlag(flags, bit) {
  return (num(flags) & bit) !== 0
}

export function isImpaired(loan) {
  return hasFlag(loan?.flags, LoanFlags.lsfLoanImpaired)
}

export function isDefaulted(loan) {
  return hasFlag(loan?.flags, LoanFlags.lsfLoanDefault)
}

export function isNpl(loan) {
  return isImpaired(loan) || isDefaulted(loan)
}

/**
 * Un prêt est en retard latent si l'échéance + grâce est dépassée
 * mais que le broker n'a pas encore impair/default — la NAV n'a pas bougé.
 */
export function isLatentDelinquent(loan, nowRipple) {
  if (!loan || isNpl(loan)) return false
  const due = num(loan.nextPaymentDueDate)
  if (!due) return false
  return nowRipple > due + num(loan.gracePeriod)
}

/**
 * Phase d'un vault fermé (rippled VaultHelpers::getVaultPhase).
 * Subscription inclusive jusqu'à SubscriptionDate ;
 * Investment strictement après ; Redemption à partir de RedemptionDate.
 */
export function vaultPhase(vault, nowRipple) {
  if (num(vault?.vaultKind, VaultKind.OpenEnded) !== VaultKind.ClosedEnded) {
    return VaultPhase.NoPhase
  }
  const sub = num(vault.subscriptionDate)
  const red = num(vault.redemptionDate)
  if (nowRipple <= sub) return VaultPhase.Subscription
  if (nowRipple < red) return VaultPhase.Investment
  return VaultPhase.Redemption
}

export function daysUntil(rippleEpoch, nowRipple) {
  return (num(rippleEpoch) - num(nowRipple)) / 86_400
}
