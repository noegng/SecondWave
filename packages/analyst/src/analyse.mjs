import { scoreBroker } from './score.mjs'
import { toAnalystInput } from './bridge.mjs'
import { resolveMeta } from './catalog.mjs'

const HHI_CONCENTRE = 2500
const LOSS_ALERT = 0.001

/** Gravité croissante : un verdict ne peut jamais être meilleur que le pire signal. */
const GRAVITE = ['sain', 'prudence', 'risqué', 'à fuir']
const pire = (a, b) => (GRAVITE.indexOf(a) >= GRAVITE.indexOf(b) ? a : b)

/** Les montants IOU sont décimaux : Number, pas BigInt. */
const n = (v) => {
  const x = Number(v ?? 0)
  return Number.isFinite(x) ? x : 0
}

/**
 * Contrat Hugo : `analyse({ graph, holders, order, meta })`.
 *
 * `nav` et `fairPricePerShare` sont ×1e6 avec 1e6 = pair (comparables entre
 * vaults quel que soit le `Scale`). `fairPrice` est le total pour `order.shares`,
 * et vaut null sans ordre — sinon l'appelant comparerait un prix par part à un
 * prix total.
 *
 * @returns {{ score: number, verdict: string, nav: number, fairPricePerShare: number|null, fairPrice: number|null, signaux: object[], codes: { red: string[], alerts: string[] } }}
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

  // Un vault hors catalogue n'a pas de DID vérifié à notre connaissance : on ne
  // lui offre pas les 10 points, sinon tout vault public inconnu part avec.
  const didVerified = meta?.ours === true
  const input = toAnalystInput(graph, { didVerified })
  const nowRipple = Number(graph.at ?? 0)
  const brokerNotes = input.brokers.map(({ broker, loans }) =>
    scoreBroker({ broker, vault: input.vault, loans, nowRipple }),
  )
  // Sans broker il n'y a aucune exposition de crédit : on note quand même par le
  // même barème, avec une exposition nulle, plutôt qu'avec une constante.
  const riskScore = brokerNotes.length
    ? Math.min(...brokerNotes.map((b) => b.riskScore))
    : scoreBroker({
        broker: { debtTotal: '0', coverAvailable: '0', coverRateMinimum: 0, coverRateLiquidation: 0, didVerified },
        vault: input.vault,
        loans: [],
        nowRipple,
      }).riskScore

  const { perShare, total } = fairPriceOf({ graph, order, score: riskScore })

  return {
    score: Math.round(riskScore),
    verdict: verdictFrom(codes, riskScore),
    nav: Number(m.navScaled ?? 0),          // ×1e6, 1e6 = pair
    fairPricePerShare: perShare,            // ×1e6, même échelle que nav
    fairPrice: total,                       // total de l'ordre, null sans `order`
    signaux,
    codes,
    brokerNotes,
  }
}

export function collectSignals({ graph, holders = {}, meta } = {}) {
  meta = resolveMeta(graph, meta)
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

  // `no-cover` ne voit que les taux à 0/0. Un broker qui annonce des taux
  // crédibles mais ne dépose presque rien est le cas réaliste, et il ne levait
  // aucun signal : la note tombait sans que le verdict bouge.
  const sousCollateral = brokers
    .map((b) => {
      const debt = n(b.metrics?.debtTotal ?? b.DebtTotal)
      const cover = n(b.metrics?.coverAvailable ?? b.CoverAvailable)
      const taux = n(b.metrics?.coverRateMinimum ?? b.CoverRateMinimum) / 100000
      const requis = n(b.metrics?.coverRequired ?? debt * taux)
      return { debt, cover, requis }
    })
    .filter((x) => x.debt > 0 && x.requis > 0 && x.cover < x.requis)
  if (sousCollateral.length) {
    const pireCas = sousCollateral.reduce((w, x) => (x.cover / x.requis < w.cover / w.requis ? x : w))
    signaux.push({
      code: 'under-collateralised',
      niveau: 'rouge',
      titre: 'first-loss sous le minimum',
      detail: `cover ${pireCas.cover} pour ${pireCas.requis} exigé (${((pireCas.cover / pireCas.requis) * 100).toFixed(1)} % du minimum annoncé)`,
    })
  }

  const debtZeroWithCover = brokers.some((b) => {
    const debt = n(b.metrics?.debtTotal ?? b.DebtTotal)
    const cover = n(b.metrics?.coverAvailable ?? b.CoverAvailable)
    return debt === 0 && cover > 0
  })
  if (debtZeroWithCover) {
    signaux.push({
      code: 'withdrawable-cover',
      niveau: 'alerte',
      titre: 'cover retirable',
      detail: 'DebtTotal = 0 : le broker peut retirer 100 % du first-loss affiché',
    })
  }

  // Avec 2 détenteurs le plus gros dépasse mécaniquement 50 % : un seuil absolu
  // allumait l'alerte sur les 7 vaults, donc n'informait sur aucun. Le seuil est
  // relatif au nombre de détenteurs (2× la part équitable).
  const count = Number(holders.count ?? 0)
  const concentration = Number(holders.concentration ?? 0)
  const hhi = Number(holders.hhi ?? 0)
  const seuil = Math.max(0.5, 2 / Math.max(count, 1))
  const concentre = count === 1
    ? concentration > 0
    : concentration >= seuil || (hhi > HHI_CONCENTRE && count >= 3)
  if (concentre) {
    signaux.push({
      code: 'concentration',
      niveau: 'alerte',
      titre: 'concentration',
      detail: count === 1
        ? 'détenteur unique : aucune contrepartie pour sortir avant la Redemption'
        : `plus gros détenteur ${(concentration * 100).toFixed(0)} % sur ${count} · HHI ${hhi}`,
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

/** Verdict = le pire entre ce que disent les signaux et ce que dit la note. */
export function verdictFrom(codes, score = 100) {
  return pire(verdictParSignaux(codes), verdictParNote(score))
}

function verdictParSignaux({ red, alerts }) {
  const r = new Set(red)
  const a = new Set(alerts)
  if (r.has('no-cover') || r.has('self-loan')) return 'à fuir'
  if (r.has('under-collateralised')) return 'risqué'
  if (r.has('clawback-armed')) return 'risqué'
  if (r.has('undeclared-default') && a.has('unrealized-loss')) return 'risqué'
  if (r.has('undeclared-default') || a.has('non-transferable')) return 'prudence'
  if (r.size) return 'risqué'
  return 'sain'
}

// Sans ce plancher un vault pouvait sortir « sain » avec 36/100 : les signaux
// rouges sont des cas nommés, la note couvre tout ce qui n'a pas de nom.
function verdictParNote(score) {
  if (score < 40) return 'à fuir'
  if (score < 55) return 'risqué'
  if (score < 70) return 'prudence'
  return 'sain'
}

/**
 * Décote linéaire de la NAV prudente par la note. `perShare` est à la même
 * échelle que `nav` (×1e6) ; `total` n'existe que si un ordre est fourni, sinon
 * on renverrait un prix par part là où l'appelant attend un total.
 */
function fairPriceOf({ graph, order, score }) {
  const m = graph.metrics ?? {}
  if (m.shareNonTransferable) return { perShare: null, total: null }
  const navPrud = Number(m.navPrudentScaled ?? 0)
  const perShare = Math.round(navPrud * Math.min(1, Math.max(0, score / 100)))
  return {
    perShare,
    total: order?.shares == null ? null : Math.round((perShare * Number(order.shares)) / 1e6),
  }
}
