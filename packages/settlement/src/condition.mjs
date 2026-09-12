/**
 * Crypto-conditions `PreimageSha256` — la seule « intelligence » programmable
 * disponible ici.
 *
 * 🔴 Le Smart Escrow (`FinishFunction`) est INEXPRIMABLE avec la lib imposée :
 *    `ripple-binary-codec@2.11.0` répond « Field FinishFunction is not defined
 *    in the definitions ». Il n'y a donc pas de WebAssembly sur ce rail — une
 *    condition à préimage, et rien d'autre. C'est suffisant pour un HTLC.
 *
 * Encodage (DER, longueurs sur un octet — d'où la préimage plafonnée à 127) :
 *   condition   A0 25 80 20 <sha256(preimage)> 81 01 <len(preimage)>
 *   fulfillment A0 <len+2> 80 <len> <preimage>
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

const HEX = /^[0-9A-Fa-f]+$/

/**
 * Génère la paire condition / fulfillment.
 * La préimage est le SECRET : le vendeur la garde jusqu'à `claim`.
 */
export function makeCondition(preimage = randomBytes(32)) {
  const buf = Buffer.isBuffer(preimage) ? preimage
    : typeof preimage === 'string' && HEX.test(preimage) && preimage.length % 2 === 0 ? Buffer.from(preimage, 'hex')
    : Buffer.from(String(preimage), 'utf8')
  if (buf.length === 0 || buf.length > 127)
    throw new RangeError(`préimage de ${buf.length} octets — attendu entre 1 et 127`)

  const digest = createHash('sha256').update(buf).digest()
  const len = buf.length.toString(16).padStart(2, '0')
  const condition = `A0258020${digest.toString('hex')}8101${len}`.toUpperCase()
  const inner = `80${len}${buf.toString('hex')}`
  const fulfillment = `A0${(inner.length / 2).toString(16).padStart(2, '0')}${inner}`.toUpperCase()

  return { preimage: buf.toString('hex').toUpperCase(), condition, fulfillment }
}

/** Le fulfillment satisfait-il la condition ? (même calcul que le ledger) */
export function verifyCondition(condition, fulfillment) {
  try {
    const preimage = preimageOf(fulfillment)
    const rebuilt = makeCondition(preimage).condition
    const a = Buffer.from(rebuilt, 'utf8'), b = Buffer.from(String(condition).toUpperCase(), 'utf8')
    return a.length === b.length && timingSafeEqual(a, b)
  } catch { return false }
}

/** Extrait la préimage d'un fulfillment DER. Lève si la forme n'est pas celle attendue. */
export function preimageOf(fulfillment) {
  const hex = String(fulfillment ?? '').toUpperCase()
  if (!HEX.test(hex) || hex.length < 8) throw new TypeError('fulfillment illisible')
  if (hex.slice(0, 2) !== 'A0') throw new TypeError('fulfillment : type PreimageSha256 attendu (A0)')
  const total = parseInt(hex.slice(2, 4), 16)
  if (hex.slice(4, 6) !== '80') throw new TypeError('fulfillment : champ 0 attendu (80)')
  const len = parseInt(hex.slice(6, 8), 16)
  if (total !== len + 2) throw new TypeError('fulfillment : longueurs incohérentes')
  const body = hex.slice(8)
  if (body.length !== len * 2) throw new TypeError('fulfillment : préimage tronquée')
  return Buffer.from(body, 'hex')
}

/** Le `Fulfillment` d'une transaction relue — v2 le laisse à la racine ou dans tx_json. */
export const fulfillmentOf = txResult =>
  txResult?.tx_json?.Fulfillment ?? txResult?.Fulfillment ?? txResult?.tx?.Fulfillment ?? null

/**
 * ⭐ Relit le secret on-chain : c'est ce qui permet à la seconde partie de
 * dénouer son propre escrow sans que la première ne lui ait rien envoyé.
 * Mesuré : le champ revient identique au bit près.
 */
export async function readSecret(client, hash) {
  const t = await client.request({ command: 'tx', transaction: hash })
  if (!t.result?.validated) return { ready: false, fulfillment: null, reason: 'transaction pas encore validée' }
  const fulfillment = fulfillmentOf(t.result)
  return fulfillment
    ? { ready: true, fulfillment, preimage: preimageOf(fulfillment).toString('hex').toUpperCase() }
    : { ready: false, fulfillment: null, reason: 'aucun Fulfillment sur cette transaction' }
}

/**
 * Frais d'un `EscrowFinish` conditionnel.
 *
 * ⚠️ L'autofill du SDK propose le frais de base et le nœud rejette : la règle
 *    `base × (33 + ⌈octets/16⌉)` n'est appliquée nulle part côté client.
 *    On double, et on plancher à 1 000 drops (valeur mesurée qui passe).
 */
export function conditionalFinishFee(fulfillment, baseFee = 10) {
  const bytes = String(fulfillment ?? '').length / 2
  const exact = baseFee * (33 + Math.ceil(bytes / 16))
  return String(Math.max(1000, exact * 2))
}
