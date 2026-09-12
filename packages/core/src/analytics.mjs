/**
 * @secondwave/core/analytics — tout ce qui se DÉRIVE d'un objet ledger vault.
 *
 * But : Noé (l'analyste) ne doit jamais lire un objet brut ni calculer une date
 * Ripple. Ces fonctions sont pures, sans réseau, et **tous les grands entiers
 * sortent en `string`** (jamais en BigInt) pour être sérialisables tels quels
 * dans snapshot.json. Les ratios sortent en `number` (0..1), lisibles.
 *
 * Les unités et formules viennent de packages/vault/src/rules.mjs, elles-mêmes
 * mesurées dans probes/RESULTATS.md. On les redéclare ici pour garder ce module
 * sans dépendance (donc testable seul).
 */
const RIPPLE_EPOCH = 946684800
export const analyticsNow = () => Math.floor(Date.now() / 1000) - RIPPLE_EPOCH

const LOAN_DEFAULT = 0x00010000
const LOAN_IMPAIRED = 0x00020000
const LOAN_OVERPAYMENT = 0x00040000
const COVER_DENOM = 100000n

const S = v => (v == null ? null : String(v))

// Un montant XRP est un entier de drops, mais un montant IOU est un décimal à
// 15 chiffres significatifs ("40.0001522071003"). BigInt() lève sur ces
// derniers : on travaille donc en virgule fixe à 1e-15 pour tout le module.
// Sans ça un vault IOU de 200 000 USD se lit comme vide, et un broker à
// DebtTotal décimal passe pour sans dette (donc cover 100 % retirable).
const AMOUNT_DEC = 15
const AMOUNT_UNIT = 10n ** BigInt(AMOUNT_DEC)
const AMOUNT_RE = /^([+-]?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/

/** Montant ledger (entier, décimal ou notation scientifique) → BigInt en 1e-15. */
const amt = v => {
  if (v == null) return 0n
  const m = AMOUNT_RE.exec(String(v).trim())
  if (!m) return 0n
  const [, sign, int = '', frac = '', exp] = m
  if (!int && !frac) return 0n
  const shift = BigInt(AMOUNT_DEC) - BigInt(frac.length) + BigInt(exp ?? 0)
  let x = BigInt(int + frac)
  x = shift >= 0n ? x * 10n ** shift : x / 10n ** -shift
  return sign === '-' ? -x : x
}

/** BigInt en 1e-15 → string décimale compacte, sans zéros de queue. */
const fmt = x => {
  if (x == null) return null
  const neg = x < 0n
  const a = neg ? -x : x
  const frac = (a % AMOUNT_UNIT).toString().padStart(AMOUNT_DEC, '0').replace(/0+$/, '')
  return `${neg ? '-' : ''}${a / AMOUNT_UNIT}${frac ? `.${frac}` : ''}`
}

/** Ratio num/den arrondi à 6 décimales, ou null si den = 0. Les échelles se compensent. */
const ratio = (num, den) => (den === 0n ? null : Number((num * 1_000_000n) / den) / 1e6)

// ─────────────────────────────────────────────────────────────
// Phase
// ─────────────────────────────────────────────────────────────
/** Phase courante, fin de phase, phase suivante — sans jamais exposer une date Ripple brute. */
export function phaseInfo(vault, at = analyticsNow()) {
  if (Number(vault.VaultKind ?? 0) !== 1) return { closed: false, phase: null }
  const sub = Number(vault.SubscriptionDate), red = Number(vault.RedemptionDate)
  let phase, endsAt, next
  if (at < sub) { phase = 'Subscription'; endsAt = sub; next = 'Investment' }
  else if (at < red) { phase = 'Investment'; endsAt = red; next = 'Redemption' }
  else { phase = 'Redemption'; endsAt = null; next = null }
  return {
    closed: true, phase, next,
    subscriptionDate: S(sub), redemptionDate: S(red),
    endsAt: endsAt == null ? null : S(endsAt),
    secondsRemaining: endsAt == null ? null : String(endsAt - at),
  }
}

// ─────────────────────────────────────────────────────────────
// Vault
// ─────────────────────────────────────────────────────────────
export function vaultMetrics(vault) {
  const total = amt(vault.AssetsTotal), avail = amt(vault.AssetsAvailable), loss = amt(vault.LossUnrealized)
  const shares = amt(vault.shares?.OutstandingAmount)
  const lent = total > avail ? total - avail : 0n
  const prudent = total > loss ? total - loss : 0n
  // Un dépôt de 1 unité d'actif émet 10^Scale parts (Scale absent ⇒ 0, cas XRP).
  // Sans ce facteur la NAV n'est pas comparable d'un vault à l'autre : un vault
  // IOU Scale 6 au pair sortirait à 1 là où un vault XRP au pair sort à 1e6.
  const scale = Number(vault.Scale ?? 0)
  const parity = 10n ** BigInt(scale)
  const nav = a => (shares === 0n ? 0n : (a * parity * 1_000_000n) / shares)
  const navScaled = nav(total)
  const navPrudScaled = nav(prudent)
  return {
    assetsTotal: fmt(total), assetsAvailable: fmt(avail), assetsLent: fmt(lent),
    lossUnrealized: fmt(loss), outstandingShares: fmt(shares), scale,
    // nav = valeur d'une part rapportée au pair. …Scaled = ×1e6 (1e6 = pair),
    // …PerShare = décimal lisible (1 = pair, 0.87 = 13 % sous le pair).
    navScaled: S(navScaled), navPerShare: Number(navScaled) / 1e6,
    navPrudentScaled: S(navPrudScaled), navPrudentPerShare: Number(navPrudScaled) / 1e6,
    utilisation: ratio(lent, total),   // part des actifs effectivement prêtée
    lossRatio: ratio(loss, total),
  }
}

// ─────────────────────────────────────────────────────────────
// Broker
// ─────────────────────────────────────────────────────────────
export function brokerMetrics(broker) {
  const cover = amt(broker.CoverAvailable), debt = amt(broker.DebtTotal)
  const dmaxRaw = amt(broker.DebtMaximum)
  const dmax = broker.DebtMaximum != null && dmaxRaw > 0n ? dmaxRaw : null   // absent/0 = illimité
  const min = Number(broker.CoverRateMinimum ?? 0), liq = Number(broker.CoverRateLiquidation ?? 0)
  const required = (debt * BigInt(min)) / COVER_DENOM
  // À DebtTotal = 0 le broker retire 100 % [E-57]. Dette > 0 : estimation (formule
  // exacte non reconstructible — voir FRICTIONS §7), on borne au required minimum.
  const withdrawable = debt === 0n ? cover : (cover > required ? cover - required : 0n)
  return {
    owner: broker.Owner ?? null,
    coverAvailable: fmt(cover), debtTotal: fmt(debt), debtMaximum: dmax == null ? null : fmt(dmax),
    coverRateMinimum: min, coverRateLiquidation: liq,
    coverRateMinimumPct: min / 1000, coverRateLiquidationPct: liq / 1000,   // 1/100000 → %
    noCover: min === 0 && liq === 0,                    // 🔴 signal rouge : aucun first-loss capital
    coverRequired: fmt(required),
    coverWithdrawable: fmt(withdrawable),
    coverWithdrawableIsEstimate: debt !== 0n,
    debtRatio: dmax == null ? null : ratio(debt, dmax),
    coverFractionOfDebt: debt === 0n ? null : ratio(cover, debt),
  }
}

// ─────────────────────────────────────────────────────────────
// Loan
// ─────────────────────────────────────────────────────────────
export function loanMetrics(loan, { at = analyticsNow(), brokerOwner = null, vaultAssetsTotal = null } = {}) {
  const flags = Number(loan.Flags ?? 0)
  const isDefault = Boolean(flags & LOAN_DEFAULT)
  const isImpaired = Boolean(flags & LOAN_IMPAIRED)
  const isOverpay = Boolean(flags & LOAN_OVERPAYMENT)
  const tvo = loan.TotalValueOutstanding
  const settled = tvo == null && !isDefault      // objet Loan soldé, en attente de LoanDelete [F-80]
  const principal = amt(loan.PrincipalOutstanding)
  const due = loan.NextPaymentDueDate != null ? Number(loan.NextPaymentDueDate) : null
  const grace = Number(loan.GracePeriod ?? 0)

  let status
  if (isDefault) status = 'en défaut'
  else if (settled) status = 'soldé'
  else if (isImpaired) status = 'impairé'
  else if (due == null || at <= due) status = 'sain'
  else if (at <= due + grace) status = 'en grâce'
  else status = 'défaillable'

  const secondsLate = due != null && at > due ? at - due : 0
  // Rien sur la chaîne ne dit qu'un prêt est défaillable : on le CALCULE. [G-89]
  const defaillable = !isDefault && !settled && due != null && at > due + grace

  return {
    borrower: loan.Borrower ?? null,
    selfLoan: brokerOwner != null && loan.Borrower === brokerOwner,   // 🔴 auto-prêt
    principalOutstanding: fmt(principal),
    totalValueOutstanding: tvo != null ? S(tvo) : null,
    nextPaymentDueDate: due != null ? S(due) : null,
    gracePeriod: S(grace),
    paymentRemaining: loan.PaymentRemaining != null ? S(loan.PaymentRemaining) : null,
    secondsLate: S(secondsLate),
    status, defaillable,
    impaired: isImpaired, defaulted: isDefault, overpayment: isOverpay,
    weight: vaultAssetsTotal != null ? ratio(principal, amt(vaultAssetsTotal)) : null,
  }
}

// ─────────────────────────────────────────────────────────────
// Concentration
// ─────────────────────────────────────────────────────────────
/** Herfindahl-Hirschman (0..10000). > 2500 = marché concentré ; 10000 = monopole. */
export function concentrationHHI(holders, total) {
  const t = amt(total)
  if (t === 0n) return 0
  let sumsq = 0n
  for (const h of holders) { const s = amt(h.shares); sumsq += s * s }
  return Number((sumsq * 10000n) / (t * t))
}
