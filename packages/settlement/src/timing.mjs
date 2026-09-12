/**
 * Le décalage des `CancelAfter` — la seule pièce de sécurité du rail HTLC.
 *
 * ═══ Le raisonnement, à relire avant de toucher aux valeurs ═══
 *
 * Deux escrows portent la MÊME condition. Le vendeur détient le secret :
 *
 *   1. le vendeur bloque les PARTS,  `CancelAfter = T_parts`
 *   2. l'acheteur bloque le PRIX,    `CancelAfter = T_prix`
 *   3. le vendeur dénoue le PRIX en révélant le secret  → il est payé
 *   4. l'acheteur relit le secret on-chain et dénoue les PARTS → il est livré
 *
 * Le vendeur agit toujours en premier, puisque lui seul connaît le secret.
 * Il choisit l'instant de l'étape 3, et l'étape 4 ne peut avoir lieu qu'après.
 *
 * ⚠️ Si `T_prix ≥ T_parts`, le vendeur attend la dernière seconde avant
 *    `T_parts`, encaisse le prix, et l'acheteur n'a plus de temps pour dénouer
 *    les parts : il a payé et ne reçoit rien. C'est la faille classique du HTLC.
 *
 * D'où la règle, non négociable :
 *
 *     T_prix  +  MARGE  ≤  T_parts
 *
 * La marge est le temps dont l'acheteur dispose, après le dernier instant où
 * le vendeur a pu encaisser, pour observer la révélation et soumettre son
 * propre `EscrowFinish`. Sur le Devnet un ledger se ferme en ~4 s ; 120 s
 * laissent une trentaine de ledgers, soit une marge confortable même si
 * l'acheteur est hors ligne quelques minutes.
 *
 * ⚠️ `CancelAfter` est OBLIGATOIRE sur les deux escrows. Un escrow de parts
 *    sans `CancelAfter` dont le destinataire perd son credential est
 *    irrécupérable À JAMAIS (`EscrowFinish` → `tecNO_AUTH`,
 *    `EscrowCancel` → `tecNO_PERMISSION`, l'objet reste au ledger). Mesuré.
 *    Les constructeurs de ce paquet lèvent plutôt que de l'omettre.
 */

/** Marge minimale entre l'expiration du prix et celle des parts, en secondes. */
export const MIN_MARGIN = 120
/** Durée minimale d'une offre : en dessous, personne n'a le temps de répondre. */
export const MIN_OFFER_TTL = 180

/**
 * Calcule les deux `CancelAfter` à partir d'une durée d'offre.
 * `now` est en secondes de l'époque Ripple (`core.rippleNow()`).
 *
 *   sharesCancelAfter — escrow du vendeur (les parts)  : le plus TARDIF
 *   priceCancelAfter  — escrow de l'acheteur (le prix) : le plus TÔT
 */
export function planTimings({ now, ttl = 600, margin = MIN_MARGIN } = {}) {
  if (!Number.isInteger(now)) throw new TypeError('`now` doit être un entier (secondes Ripple)')
  if (!Number.isInteger(ttl) || ttl < MIN_OFFER_TTL)
    throw new RangeError(`ttl de ${ttl}s — au moins ${MIN_OFFER_TTL}s sont nécessaires`)
  if (!Number.isInteger(margin) || margin < MIN_MARGIN)
    throw new RangeError(`marge de ${margin}s — au moins ${MIN_MARGIN}s (voir le raisonnement en tête de fichier)`)
  if (ttl <= margin)
    throw new RangeError(`ttl (${ttl}s) doit dépasser la marge (${margin}s), sinon l'offre expire avant d'exister`)

  const sharesCancelAfter = now + ttl
  const priceCancelAfter = sharesCancelAfter - margin
  return { now, ttl, margin, sharesCancelAfter, priceCancelAfter }
}

/**
 * Vérifie un couple de `CancelAfter` — appelé par `accept()` avant que
 * l'acheteur n'engage un drop, et testable hors ligne.
 */
export function validateTimings({ sharesCancelAfter, priceCancelAfter, now, margin = MIN_MARGIN }) {
  const problems = []
  if (!Number.isInteger(sharesCancelAfter)) problems.push('CancelAfter des parts manquant — un escrow sans CancelAfter est irrécupérable')
  if (!Number.isInteger(priceCancelAfter)) problems.push('CancelAfter du prix manquant — un escrow sans CancelAfter est irrécupérable')
  if (problems.length) return { ok: false, problems }

  if (priceCancelAfter >= sharesCancelAfter)
    problems.push(`le prix (${priceCancelAfter}) doit expirer AVANT les parts (${sharesCancelAfter}) : `
      + 'sinon le vendeur encaisse à la dernière seconde et l\'acheteur ne peut plus prendre les parts')
  else if (sharesCancelAfter - priceCancelAfter < margin)
    problems.push(`marge de ${sharesCancelAfter - priceCancelAfter}s entre les deux expirations — ${margin}s exigées `
      + 'pour que l\'acheteur ait le temps de relire le secret et de dénouer')

  if (Number.isInteger(now)) {
    if (priceCancelAfter <= now) problems.push(`l'escrow du prix est déjà expiré (${priceCancelAfter} ≤ ${now})`)
    else if (priceCancelAfter - now < 60)
      problems.push(`il reste ${priceCancelAfter - now}s avant expiration du prix — trop court pour un aller-retour`)
  }
  return { ok: problems.length === 0, problems }
}

/** Le vendeur peut-il encore encaisser sans piéger l'acheteur ? */
export function claimWindow({ priceCancelAfter, now }) {
  const left = priceCancelAfter - now
  return {
    open: left > 0, secondsLeft: left,
    warning: left > 0 && left < 60
      ? `il reste ${left}s : au-delà de ${priceCancelAfter}, l'escrow du prix n'est plus dénouable`
      : null,
  }
}
