/**
 * Les moyens de paiement — XRP, IOU, MPT.
 *
 * Le prix d'une part n'a aucune raison d'être en XRP : un fonds libellé en
 * dollar tokenisé se revend en dollar tokenisé. Les trois formes d'`Amount`
 * d'XRPL sont acceptées, mais elles ne se vérifient pas du tout de la même
 * façon — d'où cette normalisation en amont de tout le reste.
 *
 * ⚠️ Un `Payment` de MPT est strictement direct : `Paths`, `SendMax` et le
 *    cross-currency renvoient `temMALFORMED` (mesuré). Aucun de ces champs
 *    n'est donc jamais posé ici.
 */

const DROP_RE = /^\d+$/
const HEX160_RE = /^[0-9A-Fa-f]{40}$/
const MPT_ID_RE = /^[0-9A-Fa-f]{48}$/

/**
 * Normalise un montant en `{ kind, raw, value, label }`.
 *
 *   '1500000'                                  → XRP, 1,5 XRP
 *   1500000n | 1500000                         → XRP
 *   { currency:'USD', issuer:'r…', value:'5' } → IOU
 *   { mpt_issuance_id:'00…', value:'360000' }  → MPT
 *
 * `raw` est le champ `Amount` prêt à poser dans une transaction.
 */
export function normalizeAmount(input) {
  if (input === null || input === undefined) throw new TypeError('montant manquant')

  // XRP — drops, en string, bigint ou number entier.
  if (typeof input === 'bigint' || typeof input === 'number' || typeof input === 'string') {
    const s = typeof input === 'number'
      ? (Number.isInteger(input) ? String(input) : (() => { throw new TypeError(`drops non entiers : ${input}`) })())
      : String(input)
    if (!DROP_RE.test(s)) throw new TypeError(`drops invalides : « ${s} » (entier positif attendu, en drops)`)
    return { kind: 'XRP', raw: s, value: s, drops: BigInt(s), label: `${fmtDrops(s)} XRP` }
  }

  if (typeof input !== 'object') throw new TypeError(`montant illisible : ${typeof input}`)

  // Idempotence : la façade passe le montant normalisé aux deux rails, qui le
  // renormalisent. Sans cette porte, un prix en XRP déjà normalisé (objet sans
  // `currency` ni `mpt_issuance_id`) n'était plus reconnu.
  if (input.kind && input.raw !== undefined) return normalizeAmount(input.raw)

  // MPT — testé avant l'IOU : les deux portent `value`.
  if (input.mpt_issuance_id !== undefined) {
    const id = String(input.mpt_issuance_id)
    if (!MPT_ID_RE.test(id)) throw new TypeError(`mpt_issuance_id invalide : « ${id} » (48 hex attendus)`)
    const value = requireUint(input.value, 'MPT')
    return {
      kind: 'MPT', mptId: id.toUpperCase(), value,
      raw: { mpt_issuance_id: id, value },
      label: `${value} unités de ${id.slice(0, 8)}…`,
    }
  }

  // IOU
  if (input.currency !== undefined) {
    const currency = String(input.currency)
    if (!(currency.length === 3 || HEX160_RE.test(currency)))
      throw new TypeError(`devise invalide : « ${currency} » (3 caractères ou 40 hex)`)
    if (!input.issuer) throw new TypeError('IOU sans émetteur')
    const value = String(input.value ?? '')
    if (!/^\d+(\.\d+)?$/.test(value) || Number(value) <= 0)
      throw new TypeError(`valeur IOU invalide : « ${value} »`)
    return {
      kind: 'IOU', currency, issuer: String(input.issuer), value,
      raw: { currency, issuer: String(input.issuer), value },
      label: `${value} ${currency}.${String(input.issuer).slice(0, 6)}…`,
    }
  }

  throw new TypeError('montant non reconnu : ni drops, ni IOU (currency/issuer/value), ni MPT (mpt_issuance_id/value)')
}

function requireUint(v, what) {
  const s = String(v ?? '')
  if (!DROP_RE.test(s) || s === '0') throw new TypeError(`quantité ${what} invalide : « ${s} » (entier > 0 attendu)`)
  return s
}

/** Deux montants désignent-ils le même actif ? (la quantité n'entre pas en compte) */
export function sameAsset(a, b) {
  const x = normalizeAmount(a), y = normalizeAmount(b)
  if (x.kind !== y.kind) return false
  if (x.kind === 'XRP') return true
  if (x.kind === 'MPT') return x.mptId === y.mptId
  return x.currency === y.currency && x.issuer === y.issuer
}

/** Clé stable d'un actif — utile pour indexer un historique de prix. */
export const assetKey = amount => {
  const a = normalizeAmount(amount)
  return a.kind === 'XRP' ? 'XRP' : a.kind === 'MPT' ? `MPT:${a.mptId}` : `IOU:${a.currency}.${a.issuer}`
}

/** Le montant lu sur une transaction relue, ou null si ce n'en est pas un. */
export function readAmount(raw) {
  if (raw === null || raw === undefined) return null
  try { return normalizeAmount(raw) } catch { return null }
}

/**
 * Prix unitaire dans l'unité du prix — drops/part pour l'XRP, unités/part sinon.
 * Number est assumé : c'est un indicateur d'affichage, jamais une somme d'argent.
 */
export function pricePerUnit(priceAmount, shares) {
  const p = normalizeAmount(priceAmount)
  const s = Number(shares)
  if (!s) return null
  return Number(p.value) / s
}

export const fmtDrops = d => (Number(d) / 1e6).toFixed(6)

/** Libellé court d'un prix rapporté à une quantité de parts. */
export function priceLabel(priceAmount, shares) {
  const p = normalizeAmount(priceAmount)
  const per = pricePerUnit(p, shares)
  const unit = p.kind === 'XRP' ? 'drops/part' : `${p.kind === 'IOU' ? p.currency : 'unités'}/part`
  return `${p.label}${per === null ? '' : ` (${per.toFixed(6)} ${unit})`}`
}
