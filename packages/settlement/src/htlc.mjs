/**
 * RAIL « htlc » — l'échange atomique sans `Batch`, par deux escrows liés.
 *
 * Deux escrows portent la MÊME condition `PreimageSha256`. Le secret, révélé
 * on-chain par le premier dénouement, autorise le second : l'atomicité ne vient
 * plus d'une transaction composée mais de la cryptographie.
 *
 *   propose  le vendeur bloque les PARTS   (condition, CancelAfter le plus tardif)
 *   accept   l'acheteur bloque le PRIX     (même condition, CancelAfter plus tôt)
 *   claim    le vendeur révèle le secret et encaisse le prix
 *   settle   l'acheteur relit le secret on-chain et prend les parts
 *   refund   après expiration, chacun récupère son dépôt
 *
 * Trois propriétés mesurées qui font l'intérêt de ce rail :
 *   · `EscrowFinish` CRÉE l'objet `MPToken` du destinataire — pas de jambe
 *     d'autorisation, donc pas le faux négatif de preflight du rail Batch ;
 *   · le gate du domaine est REVÉRIFIÉ au dénouement, pas seulement à la
 *     création — un acheteur exclu entre-temps ne reçoit rien ;
 *   · n'importe qui peut soumettre le `EscrowFinish` : le règlement est
 *     délégable à un tiers (relayer).
 *
 * 🔴 `CancelAfter` est OBLIGATOIRE ici. Un escrow de parts sans `CancelAfter`
 *    dont le destinataire perd son credential est irrécupérable À JAMAIS
 *    (`Finish` → tecNO_AUTH, `Cancel` → tecNO_PERMISSION). Ces fonctions lèvent
 *    plutôt que de construire un tel escrow.
 */
import { submit, sequence, rippleNow, txUrl } from '@secondwave/core'
import { normalizeAmount } from './amounts.mjs'
import { makeCondition, conditionalFinishFee, readSecret, verifyCondition } from './condition.mjs'
import { planTimings, validateTimings, claimWindow, MIN_MARGIN } from './timing.mjs'

const step = (name, r, extra = {}) => ({
  step: name, ok: r.ok, result: r.result, message: r.message ?? null,
  hash: r.hash ?? null, url: r.hash ? txUrl(r.hash) : null,
  fee: BigInt(r.raw?.result?.tx_json?.Fee ?? r.raw?.result?.Fee ?? 0),
  ...extra,
})

/** La séquence qu'une transaction vient de consommer — c'est l'`OfferSequence`. */
const consumedSequence = (r, fallback) =>
  r.raw?.result?.tx_json?.Sequence ?? r.raw?.result?.Sequence ?? fallback ?? null

/**
 * ÉTAPE 1 — le vendeur bloque ses parts.
 *
 * Fournir `ttl` (secondes) pour laisser le module calculer les deux échéances,
 * ou `cancelAfter` explicitement. Sans l'un ni l'autre : exception.
 */
export async function propose(client, {
  sellerWallet, buyer, mptId, shares, ttl = 600, cancelAfter = null, margin = MIN_MARGIN,
  condition = null, secret = null,
}) {
  const now = rippleNow()
  const timings = cancelAfter === null
    ? planTimings({ now, ttl, margin })
    : { now, margin, sharesCancelAfter: cancelAfter, priceCancelAfter: cancelAfter - margin, ttl: cancelAfter - now }

  if (!Number.isInteger(timings.sharesCancelAfter))
    throw new TypeError('CancelAfter obligatoire : un escrow de parts sans CancelAfter est irrécupérable à jamais')
  if (timings.sharesCancelAfter <= now + 60)
    throw new RangeError(`CancelAfter à ${timings.sharesCancelAfter - now}s — au moins 60s, sinon l'offre expire avant d'être vue`)

  // Le secret reste chez le vendeur jusqu'à `claim`.
  const c = condition ? { condition, fulfillment: secret } : makeCondition()

  const seq = await sequence(client, sellerWallet.classicAddress)
  const r = await submit(client, {
    TransactionType: 'EscrowCreate', Account: sellerWallet.classicAddress, Destination: buyer,
    Amount: { mpt_issuance_id: mptId, value: String(shares) },
    Condition: c.condition, CancelAfter: timings.sharesCancelAfter,
  }, sellerWallet)

  return {
    ...step('propose', r),
    condition: c.condition, fulfillment: c.fulfillment,      // ⚠️ secret : ne jamais publier avant `claim`
    offerSequence: r.ok ? consumedSequence(r, seq) : null,
    owner: sellerWallet.classicAddress, destination: buyer,
    sharesCancelAfter: timings.sharesCancelAfter,
    priceCancelAfter: timings.priceCancelAfter,
    shares: String(shares), mptId,
  }
}

/**
 * ÉTAPE 2 — l'acheteur bloque le prix, sous la MÊME condition.
 * Refuse tout couple d'échéances qui le mettrait en danger (voir `timing.mjs`).
 */
export async function accept(client, {
  buyerWallet, seller, price, condition, priceCancelAfter, sharesCancelAfter, margin = MIN_MARGIN,
}) {
  const now = rippleNow()
  const v = validateTimings({ sharesCancelAfter, priceCancelAfter, now, margin })
  if (!v.ok) return { step: 'accept', ok: false, result: 'timings-refusés', blockers: v.problems, hash: null, url: null }
  if (!condition) throw new TypeError('condition manquante — `accept` doit reprendre EXACTEMENT celle du vendeur')

  const amount = normalizeAmount(price)
  const seq = await sequence(client, buyerWallet.classicAddress)
  const r = await submit(client, {
    TransactionType: 'EscrowCreate', Account: buyerWallet.classicAddress, Destination: seller,
    Amount: amount.raw, Condition: condition, CancelAfter: priceCancelAfter,
  }, buyerWallet)

  return {
    ...step('accept', r),
    offerSequence: r.ok ? consumedSequence(r, seq) : null,
    owner: buyerWallet.classicAddress, destination: seller,
    priceCancelAfter, sharesCancelAfter, price: amount.raw, priceLabel: amount.label,
  }
}

/**
 * ÉTAPE 3 — le vendeur encaisse le prix en révélant le secret.
 * C'est ici que le secret devient public : la fenêtre se referme à
 * `priceCancelAfter`, et l'acheteur doit encore avoir le temps de dénouer.
 */
export async function claim(client, {
  sellerWallet, buyerEscrow, condition, fulfillment, priceCancelAfter = null,
}) {
  if (!verifyCondition(condition, fulfillment))
    throw new Error('le fulfillment ne satisfait pas la condition — inutile de soumettre')

  const w = priceCancelAfter === null ? { open: true, warning: null }
    : claimWindow({ priceCancelAfter, now: rippleNow() })
  if (!w.open)
    return { step: 'claim', ok: false, result: 'fenêtre-fermée', hash: null, url: null,
             message: `l'escrow du prix a expiré (CancelAfter ${priceCancelAfter}) — passer par refund` }

  const r = await submit(client, {
    TransactionType: 'EscrowFinish', Account: sellerWallet.classicAddress,
    Owner: buyerEscrow.owner, OfferSequence: buyerEscrow.offerSequence,
    Condition: condition, Fulfillment: fulfillment,
    Fee: conditionalFinishFee(fulfillment),
  }, sellerWallet)

  return { ...step('claim', r), warning: w.warning, revealed: r.ok }
}

/**
 * ÉTAPE 4 — l'acheteur relit le secret ON-CHAIN et prend les parts.
 * Il n'a besoin de rien d'autre que le hash de l'étape 3.
 */
export async function settle(client, { buyerWallet, sellerEscrow, condition, claimHash, fulfillment = null }) {
  let ff = fulfillment
  let source = 'fourni'
  if (!ff) {
    if (!claimHash) throw new TypeError('ni fulfillment ni claimHash — impossible de dénouer')
    const s = await readSecret(client, claimHash)
    if (!s.ready)
      return { step: 'settle', ok: false, result: 'secret-indisponible', hash: null, url: null, message: s.reason }
    ff = s.fulfillment
    source = 'relu on-chain'
  }
  if (!verifyCondition(condition, ff))
    return { step: 'settle', ok: false, result: 'secret-invalide', hash: null, url: null,
             message: 'le secret relu ne satisfait pas la condition' }

  const r = await submit(client, {
    TransactionType: 'EscrowFinish', Account: buyerWallet.classicAddress,
    Owner: sellerEscrow.owner, OfferSequence: sellerEscrow.offerSequence,
    Condition: condition, Fulfillment: ff,
    Fee: conditionalFinishFee(ff),
  }, buyerWallet)

  return { ...step('settle', r), secretSource: source, fulfillment: ff }
}

/**
 * Après expiration — chacun récupère son dépôt. N'importe qui peut soumettre.
 * ⚠️ Sans `CancelAfter`, cette porte n'existe pas : `tecNO_PERMISSION`.
 */
export async function refund(client, { wallet, escrow }) {
  const r = await submit(client, {
    TransactionType: 'EscrowCancel', Account: wallet.classicAddress,
    Owner: escrow.owner, OfferSequence: escrow.offerSequence,
  }, wallet)
  return step('refund', r)
}

/**
 * L'escrow est-il encore au ledger ? Lecture exacte par `(owner, seq)` —
 * un objet Escrow ne porte pas sa propre séquence, seul ce couple l'identifie.
 */
export async function escrowStillOpen(client, { owner, offerSequence }) {
  try {
    const r = await client.request({
      command: 'ledger_entry', escrow: { owner, seq: Number(offerSequence) }, ledger_index: 'validated',
    })
    return { open: true, node: r.result.node }
  } catch (e) {
    const err = e.data?.error ?? e.message
    return { open: false, reason: err === 'entryNotFound' ? 'dénoué ou annulé' : err }
  }
}
