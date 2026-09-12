import { scoreBroker } from './score.mjs'
import { toAnalystInput } from './bridge.mjs'
import { resolveMeta } from './catalog.mjs'

const HHI_CONCENTRE = 2500
const LOSS_ALERT = 0.001
const COVER_DUST = 0n

const big = (v) => {
  try { return BigInt(v ?? 0) } catch { return 0n }
}

/**
 * Contrat Hugo : `analyse({ graph, holders, order, meta })`.
 *
 * @returns {{ score: number, verdict: string, nav: number, fairPrice: number|null, signaux: object[], codes: { red: string[], alerts: string[] } }}
 */
export function analyse({ graph, holders = {}, order, meta } = {}) {
  if (!graph) throw new Error('analyse() attend { graph }')

  meta = resolveMeta(graph, meta)
  const m = graph.metrics ?? {}
  const signaux = collectSignals({ graph, holders, meta })
  const codes = {
    red: signaux.filter((s) => s.niveau === 'rouge').map((s) => s.code),
    alerts: signaux.filter((s) => s.niveau === 'alerte').map((s) => s.code),
  }

  const input = toAnalystInput(graph, { didVerified: meta?.ours !== false })
  const nowRipple = Number(graph.at ?? 0)
  const brokerNotes = input.brokers.map(({ broker, loans }) =>
    scoreBroker({ broker, vault: input.vault, loans, nowRipple }),
  )
  const riskScore = brokerNotes.length
    ? Math.min(...brokerNotes.map((n) => n.riskScore))
    : 80

  const verdict = verdictFrom(codes)
  const nav = Number(m.navScaled ?? 0)
  const fairPrice = fairPriceOf({ graph, order, score: riskScore })

  return {
    score: Math.round(riskScore),
    verdict,
    nav,
    fairPrice,
    signaux,
    codes,
    brokerNotes,
  }
}

export function collectSignals({ graph, holders = {}, meta } = {}) {
  const m = graph.metrics ?? {}
  const signaux = []
  const brokers = graph.brokers ?? []

  if (m.hasUncoveredBroker || brokers.some((b) => b.metrics?.noCover)) {
    signaux.push({
      code: 'no-cover',
      niveau: 'rouge',
      titre: 'cover à zéro',
      detail: 'aucun first-loss : au défaut la perte tombe à 100 % sur les déposants',
    })
  }

  if (m.hasSelfLoan || brokers.some((b) => b.loans?.some((l) => l.metrics?.selfLoan))) {
    signaux.push({
      code: 'self-loan',
      niveau: 'rouge',
      titre: 'auto-prêt',
      detail: 'le gérant s\'emprunte à lui-même via son propre broker',
    })
  }

  if (m.hasUndeclaredDefault || brokers.some((b) => b.loans?.some((l) => l.metrics?.defaillable))) {
    signaux.push({
      code: 'undeclared-default',
      niveau: 'rouge',
      titre: 'défaillable non déclaré',
      detail: 'échéance + grâce dépassées sans défaut déclaré — la NAV ne bouge pas',
    })
  }

  if (meta?.clawbackArmed) {
    signaux.push({
      code: 'clawback-armed',
      niveau: 'rouge',
      titre: 'clawback armé',
      detail: "l'émetteur de l'actif IOU peut saisir la position d'un déposant",
    })
  }

  const debtZeroWithCover = brokers.some((b) => {
    const debt = big(b.metrics?.debtTotal ?? b.DebtTotal)
    const cover = big(b.metrics?.coverAvailable ?? b.CoverAvailable)
    return debt === 0n && cover > COVER_DUST
  })
  if (debtZeroWithCover) {
    signaux.push({
      code: 'withdrawable-cover',
      niveau: 'alerte',
      titre: 'cover retirable',
      detail: 'DebtTotal = 0 : le broker peut retirer 100 % du first-loss affiché',
    })
  }

  const concentration = Number(holders.concentration ?? 0)
  const hhi = Number(holders.hhi ?? 0)
  if (concentration >= 0.5 || hhi > HHI_CONCENTRE) {
    signaux.push({
      code: 'concentration',
      niveau: 'alerte',
      titre: 'concentration',
      detail: `plus gros détenteur ${(concentration * 100).toFixed(0)} % · HHI ${hhi}`,
    })
  }

  if (Number(m.lossRatio ?? 0) > LOSS_ALERT || brokers.some((b) => b.loans?.some((l) => l.metrics?.impaired))) {
    signaux.push({
      code: 'unrealized-loss',
      niveau: 'alerte',
      titre: 'perte latente',
      detail: `NAV nominale ${m.navPerShare} vs prudente ${m.navPrudentPerShare} (lossRatio ${m.lossRatio ?? 0})`,
    })
  }

  if (m.shareNonTransferable) {
    signaux.push({
      code: 'non-transferable',
      niveau: 'alerte',
      titre: 'parts non transférables',
      detail: 'aucune sortie par le marché secondaire — seule la Redemption ouvre',
    })
  }

  if (holders.reconciles === false) {
    signaux.push({
      code: 'reconcile-mismatch',
      niveau: 'rouge',
      titre: 'rejeu divergent',
      detail: 'la somme des parts rejouées ne retombe pas sur OutstandingAmount',
    })
  }

  return signaux
}

function verdictFrom({ red, alerts }) {
  const r = new Set(red)
  const a = new Set(alerts)
  if (r.has('no-cover') || r.has('self-loan')) return 'à fuir'
  if (r.has('clawback-armed')) return 'risqué'
  if (r.has('undeclared-default') && a.has('unrealized-loss')) return 'risqué'
  if (r.has('undeclared-default') || a.has('non-transferable')) return 'prudence'
  if (r.size) return 'risqué'
  return 'sain'
}

function fairPriceOf({ graph, order, score }) {
  const m = graph.metrics ?? {}
  if (m.shareNonTransferable) return null
  const navPrud = Number(m.navPrudentScaled ?? 0)
  const risk = Math.max(0.35, score / 100)
  if (order?.shares != null) {
    return Math.round((navPrud * Number(order.shares) / 1e6) * risk)
  }
  return Math.round(navPrud * risk)
}
