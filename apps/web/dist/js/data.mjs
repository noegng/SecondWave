/**
 * Couche données de l'interface — lecture seule.
 *
 * Tout vient des trois fichiers écrits par `npm run world` et le CLI :
 *   · snapshot.json  — l'état figé de chaque vault (NAV, parts, prêts)
 *   · world.json     — identifiants publics, détenteurs de parts
 *   · orderbook.json — le carnet réel (souvent une poignée d'ordres)
 *
 * Le carnet réel étant maigre entre deux démos, on le complète d'offres de
 * démonstration dérivées des vrais détenteurs du monde — clairement marquées
 * `demo: true` et jamais écrites sur disque.
 */

const RIPPLE_EPOCH = 946684800
export const rippleNow = () => Math.floor(Date.now() / 1000) - RIPPLE_EPOCH

/** Analyst grades for the world's seven scenarios (offline version). */
export const RATINGS = {
  sain:       { grade: 'A', tone: 'good',  why: 'First-loss covered, loans performing' },
  solde:      { grade: 'A', tone: 'good',  why: 'Zero debt, clean wind-down' },
  redemption: { grade: 'B', tone: 'good',  why: 'Redemption phase — normal exit is open' },
  deprecie:   { grade: 'C', tone: 'warn',  why: 'Impairment booked, partial rehab' },
  iou:        { grade: 'C', tone: 'warn',  why: 'Seizable asset — clawback armed at the issuer' },
  predateur:  { grade: 'E', tone: 'bad',   why: 'Owner self-loan, zero first-loss, never repaid' },
  verrouille: { grade: '—', tone: 'mute',  why: 'Non-transferable shares: no market possible' },
}

const SHORT = {
  sain: 'Healthy vault', predateur: 'Self-dealing vault', deprecie: 'Impaired vault',
  iou: 'IOU vault', verrouille: 'Locked vault', redemption: 'Redemption vault',
  solde: 'Settled vault',
}

export async function loadWorld() {
  const [snapshot, world, book] = await Promise.all(
    ['snapshot.json', 'world.json', 'orderbook.json'].map(f =>
      fetch(`/data/${f}`).then(r => (r.ok ? r.json() : null)).catch(() => null)),
  )

  const vaults = {}
  for (const [key, v] of Object.entries(snapshot?.vaults ?? {})) {
    const g = v.graph.vault
    const outstanding = Number(g.shares.OutstandingAmount)
    const assetsTotal = Number(g.AssetsTotal)
    const currency = g.Asset?.currency ?? 'XRP'
    const isXrp = currency === 'XRP'
    const navPerShare = outstanding > 0 ? assetsTotal / outstanding : 0
    const wv = (world?.vaults ?? []).find(x => x.key === key)
    vaults[key] = {
      key,
      label: v.meta.label,
      short: SHORT[key] ?? key,
      vaultId: v.meta.vaultId,
      shareMptId: v.meta.shareMptId ?? g.ShareMPTID ?? wv?.shareMptId ?? null,
      asset: currency,
      isXrp,
      assetsTotal,
      assetsAvailable: Number(g.AssetsAvailable),
      outstanding,
      navPerShare,
      clawbackArmed: !!v.meta.clawbackArmed,
      redemptionDate: v.meta.redemptionDate,
      subscriptionDate: v.meta.subscriptionDate,
      transferable: key !== 'verrouille',
      phase: v.meta.redemptionDate <= rippleNow() ? 'Redemption' : 'Investment',
      holders: wv?.holders ?? [],
      loans: wv?.loans ?? [],
      rating: RATINGS[key] ?? { grade: '?', tone: 'mute', why: '' },
    }
  }

  const offers = [
    ...(book ?? []).map(o => ({ ...o, demo: false })),
    ...demoOffers(vaults),
  ]

  return { vaults, offers, world, generatedAt: snapshot?.generatedAt ?? null }
}

/**
 * Offres de démonstration : chaque vendeur est un vrai détenteur du monde,
 * chaque prix raconte l'histoire du scénario — petite décote de liquidité
 * sur les vaults sains, décote profonde là où le risque est caché.
 */
function demoOffers(vaults) {
  const now = rippleNow()
  const spec = [
    // [vault, holderIdx, part des parts vendue, décote vs NAV, âge (s), ttl (s)]
    ['sain',       0, 0.24, 0.031, 540, 3600],
    ['sain',       1, 0.55, 0.128, 130, 1800],
    ['solde',      0, 0.18, 0.042, 900, 7200],
    ['redemption', 1, 0.30, 0.018, 1500, 3600],
    ['deprecie',   0, 0.40, 0.185, 260, 3600],
    ['iou',        1, 0.35, 0.102, 700, 5400],
    ['predateur',  0, 0.60, 0.284, 60, 1800],
    ['predateur',  1, 0.45, 0.310, 2100, 2700],
  ]
  const out = []
  let n = 0
  for (const [key, hi, frac, discount, age, ttl] of spec) {
    const v = vaults[key]
    if (!v || !v.transferable) continue
    const holder = v.holders[hi] ?? v.holders[0]
    if (!holder) continue
    const shares = Math.round(Number(holder.shares) * frac)
    const price = Math.round(shares * v.navPerShare * (1 - discount))
    out.push({
      id: `d${String(++n).padStart(3, '0')}`,
      vaultId: v.vaultId,
      seller: holder.account,
      shares: String(shares),
      price: String(Math.max(price, 1)),
      postedAt: now - age,
      expiry: now - age + ttl,
      status: 'open',
      txHash: null,
      demo: true,
    })
  }
  return out
}

export function vaultById(vaults, vaultId) {
  return Object.values(vaults).find(v => v.vaultId === vaultId) ?? null
}

/** 1 000 000 drops = 1 XRP ; les IOU s'affichent tels quels. */
export function fmtAsset(amount, vault, { compact = false } = {}) {
  if (vault?.isXrp === false) {
    return `${fmtNum(amount, compact)} ${vault.asset}`
  }
  const xrp = amount / 1_000_000
  return `${fmtNum(xrp, compact)} XRP`
}

export function fmtNum(x, compact = false) {
  if (!Number.isFinite(x)) return '—'
  if (compact && Math.abs(x) >= 1_000_000) return `${(x / 1_000_000).toFixed(2)} M`
  if (compact && Math.abs(x) >= 10_000) return `${(x / 1_000).toFixed(1)} k`
  return x.toLocaleString('en-US', { maximumFractionDigits: x < 10 ? 4 : 2 })
}

/** Durée en secondes → libellé compact. */
export function fmtDuration(s) {
  if (!Number.isFinite(s)) return '—'
  const abs = Math.abs(s)
  if (abs < 60) return `${Math.round(abs)} s`
  if (abs < 3600) return `${Math.round(abs / 60)} min`
  if (abs < 86400) return `${(abs / 3600).toFixed(1)} h`
  return `${(abs / 86400).toFixed(1)} d`
}

/** NAV par part avec une précision qui suit l'ordre de grandeur. */
export function fmtNav(navPerShare) {
  if (!Number.isFinite(navPerShare) || navPerShare === 0) return '—'
  return navPerShare >= 0.01 ? navPerShare.toFixed(4) : navPerShare.toPrecision(3)
}

export function fmtShares(shares) {
  return Number(shares).toLocaleString('en-US')
}

export function shortAddr(a) {
  return a ? `${a.slice(0, 6)}…${a.slice(-4)}` : '—'
}

/** Décote de l'offre par rapport à la NAV du vault. Négatif = surcote. */
export function discountOf(offer, vault) {
  const nav = Number(offer.shares) * vault.navPerShare
  if (nav <= 0) return 0
  return 1 - Number(offer.price) / nav
}

export function timeLeft(offer) {
  // Une offre durable est portée par des Tickets : elle n'a pas d'échéance.
  // Afficher un compte à rebours serait un mensonge, et « expired » un bug.
  if (offer.expiry == null) return { label: 'no expiry', expired: false, durable: true }
  const s = offer.expiry - rippleNow()
  if (s <= 0) return { label: 'expired', expired: true }
  if (s < 90) return { label: `${s} s`, expired: false }
  if (s < 3600) return { label: `${Math.round(s / 60)} min`, expired: false }
  return { label: `${(s / 3600).toFixed(1)} h`, expired: false }
}
