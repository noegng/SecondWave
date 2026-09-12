/**
 * RECONCILE — les soldes avant/après. La seule vérité.
 *
 * Sur ce rail, le code de retour ment : un `Batch` dont aucune jambe n'a
 * appliqué renvoie `tesSUCCESS` avec une meta à un seul nœud (la ponction de
 * frais). Sept chemins d'échec silencieux distincts ont été mesurés. Aucune
 * couche au-dessus ne doit conclure autrement qu'en comparant des soldes.
 */
import { shareBalance, xrpBalance } from '@secondwave/core'
import { normalizeAmount } from './amounts.mjs'

/**
 * Solde d'un compte dans l'actif d'un montant donné.
 * XRP et MPT sont exacts (bigint) ; un IOU est décimal, donc Number — il sert
 * à constater un mouvement, jamais à faire de la comptabilité.
 */
export async function assetBalance(client, account, amount) {
  const a = normalizeAmount(amount)
  if (a.kind === 'XRP') return { kind: 'XRP', exact: true, value: await xrpBalance(client, account) }
  if (a.kind === 'MPT') return { kind: 'MPT', exact: true, value: (await shareBalance(client, account, a.mptId)).amount }
  try {
    const r = await client.request({
      command: 'account_lines', account, peer: a.issuer, ledger_index: 'validated',
    })
    const line = r.result.lines.find(l => l.currency === a.currency)
    return { kind: 'IOU', exact: false, value: Number(line?.balance ?? 0) }
  } catch { return { kind: 'IOU', exact: false, value: 0 } }
}

/** Photo complète des deux parties : parts, XRP, et l'actif du prix. */
export async function snapshot(client, { mptId, price, seller, buyer }) {
  const p = normalizeAmount(price)
  const [sellerShares, buyerShares, sellerXrp, buyerXrp] = await Promise.all([
    shareBalance(client, seller, mptId).then(x => x.amount),
    shareBalance(client, buyer, mptId).then(x => x.amount),
    xrpBalance(client, seller),
    xrpBalance(client, buyer),
  ])
  const [sellerPrice, buyerPrice] = p.kind === 'XRP'
    ? [{ kind: 'XRP', exact: true, value: sellerXrp }, { kind: 'XRP', exact: true, value: buyerXrp }]
    : await Promise.all([assetBalance(client, seller, p), assetBalance(client, buyer, p)])
  return { sellerShares, buyerShares, sellerXrp, buyerXrp, sellerPrice, buyerPrice }
}

const sub = (a, b) => (typeof a === 'bigint' ? a - b : Number((a - b).toFixed(9)))

/**
 * Ce qui a réellement bougé, et si cela correspond à l'échange annoncé.
 * `shares` est la quantité attendue ; l'écart de prix est constaté, pas exigé
 * (les frais s'y mêlent côté XRP).
 */
export function reconcile(before, after, { shares, price }) {
  const p = normalizeAmount(price)
  const moved = {
    shares: before.sellerShares - after.sellerShares,
    received: after.buyerShares - before.buyerShares,
    paid: sub(before.buyerPrice.value, after.buyerPrice.value),
    collected: sub(after.sellerPrice.value, before.sellerPrice.value),
    priceKind: p.kind,
  }
  const want = BigInt(shares)
  const sharesOk = moved.shares === want && moved.received === want
  // Côté prix : on exige un mouvement dans le bon sens, d'au moins le montant
  // annoncé pour le vendeur (les frais du vendeur peuvent le réduire en XRP).
  const priceMoved = p.kind === 'XRP'
    ? moved.collected > 0n || moved.paid >= BigInt(p.value)
    : Number(moved.collected) > 0

  return {
    moved, sharesOk, priceMoved,
    ok: sharesOk && priceMoved,
    warning: sharesOk && priceMoved ? null
      : !sharesOk && moved.received === 0n
        ? 'aucune part n\'a bougé — échec silencieux : le code de retour ne le dit pas, les soldes si'
        : !sharesOk
          ? `parts déplacées ${moved.shares} / reçues ${moved.received} pour ${shares} attendues`
          : 'les parts ont bougé mais aucun prix n\'est arrivé au vendeur — vérifier la jambe du prix',
  }
}
