/**
 * Le seuil de solvabilité de l'acheteur — mesuré au drop près.
 *
 * ⭐ Fait mesuré (sonde `probes-marche/07b-reserve-exacte.mjs`) :
 *
 *     solde_après_paiement  ≥  base + inc × (OwnerCount + objets_créés)
 *
 *    L'objet `MPToken` que la jambe d'autorisation va créer compte **avant**
 *    que le prix ne parte. À ce seuil exact : les parts sont livrées. Un drop
 *    en dessous : `tesSUCCESS`, meta à un nœud, et rien ne bouge. Aucun `tec`
 *    ne remonte jamais.
 *
 * D'où ce module : le preflight a besoin du seuil exact, pas d'une marge
 * forfaitaire (l'ancienne valeur de 2 XRP était sûre mais opaque — elle
 * refusait des acheteurs solvables et n'expliquait rien).
 */

/** Valeurs du Devnet public, relues par `readReserve` quand un client est là. */
export const DEFAULT_RESERVE = { base: 1_000_000n, inc: 200_000n }

/** Réserves réelles du réseau, en drops. */
export async function readReserve(client) {
  try {
    const l = (await client.request({ command: 'server_info' })).result.info.validated_ledger
    return {
      base: BigInt(Math.round(l.reserve_base_xrp * 1e6)),
      inc: BigInt(Math.round(l.reserve_inc_xrp * 1e6)),
    }
  } catch { return DEFAULT_RESERVE }
}

/** `OwnerCount` et solde XRP d'un compte. Un compte inexistant vaut zéro. */
export async function accountFootprint(client, account) {
  try {
    const r = await client.request({ command: 'account_info', account, ledger_index: 'validated' })
    return {
      exists: true,
      balance: BigInt(r.result.account_data.Balance),
      ownerCount: Number(r.result.account_data.OwnerCount ?? 0),
    }
  } catch { return { exists: false, balance: 0n, ownerCount: 0 } }
}

/** Réserve exigée d'un compte qui portera `ownerCount + newObjects` objets. */
export const reserveFor = (ownerCount, newObjects = 0, reserve = DEFAULT_RESERVE) =>
  reserve.base + reserve.inc * BigInt(Math.max(0, ownerCount + newObjects))

/**
 * Le solde XRP d'un acheteur suffit-il ?
 *
 * `priceDrops` vaut 0 quand le prix est payé en IOU ou en MPT : seule la
 * réserve et les frais restent à couvrir en XRP.
 */
export function buyerSolvency({
  balance, ownerCount, priceDrops = 0n, newObjects = 1, fees = 0n, reserve = DEFAULT_RESERVE,
}) {
  const need = reserveFor(ownerCount, newObjects, reserve)
  const required = BigInt(priceDrops) + need + BigInt(fees)
  const ok = BigInt(balance) >= required
  return {
    ok, required, reserveRequired: need, missing: ok ? 0n : required - BigInt(balance),
    detail: ok
      ? `${balance} ≥ ${required} drops (prix ${priceDrops} + réserve ${need} + frais ${fees})`
      : `${balance} < ${required} drops — il manque ${required - BigInt(balance)} drops `
        + `(prix ${priceDrops} + réserve ${need} pour ${ownerCount}+${newObjects} objets + frais ${fees})`,
  }
}

/**
 * Le vendeur aussi a une réserve : il ne crée aucun objet sur le rail Batch,
 * mais il en crée un sur le rail HTLC (son escrow), et il paie l'enveloppe.
 */
export function sellerSolvency({ balance, ownerCount, newObjects = 0, fees = 0n, reserve = DEFAULT_RESERVE }) {
  const need = reserveFor(ownerCount, newObjects, reserve)
  const required = need + BigInt(fees)
  const ok = BigInt(balance) >= required
  return {
    ok, required, reserveRequired: need, missing: ok ? 0n : required - BigInt(balance),
    detail: ok ? `${balance} ≥ ${required} drops`
      : `${balance} < ${required} drops — il manque ${required - BigInt(balance)} drops`,
  }
}
