/**
 * RAIL « durable » — le rail Batch, mais l'offre survit à l'attente.
 *
 * Le rail `batch` classique (batch.mjs) construit et signe tout d'un coup :
 * les deux parties doivent être là en même temps, et l'enveloppe meurt en
 * ~72 s (`LastLedgerSequence: li + 25`) ou dès que l'un des deux comptes
 * transige ailleurs. C'est une poignée de main, pas un carnet.
 *
 * Ici, les mêmes trois jambes, mais portées par des Tickets et sans expiration.
 * La signature se fait en deux temps, dans cet ordre :
 *
 *   1. `buildOffer()`    l'enveloppe non signée — personne n'est engagé
 *   2. `signAsBuyer()`   l'acheteur pose ses `BatchSigners`
 *   3. `signAsSeller()`  le vendeur signe l'enveloppe — c'est sa confirmation
 *   4. `submitOffer()`   n'importe qui peut soumettre
 *
 * L'ordre acheteur-puis-vendeur n'est pas imposé par la cryptographie
 * (`BatchSigners` a `isSigningField=false`, la signature du vendeur ne le
 * couvre pas) mais par le métier : le vendeur ne peut pas signer avant de
 * connaître l'acheteur, dont l'adresse est dans `RawTransactions`, qui est
 * signé. C'est la raison pour laquelle il n'existe pas d'offre au porteur.
 *
 * Entre 2 et 3, l'offre attend aussi longtemps qu'il faut. Le vendeur garde
 * la main : `consumeTicket()` sur le ticket de l'enveloppe tue l'offre, même
 * déjà signée par l'acheteur (mesuré : `probes-marche/14`, C5).
 */
import { BatchFlags, signMultiBatch } from 'xrpl'
import { encodeForSigning } from 'ripple-binary-codec'
import { sign as kpSign } from 'ripple-keypairs'
import { normalizeAmount } from './amounts.mjs'
import { submitBatch, innerResults } from './batch.mjs'
import { TICKETS_SELLER, ticketsBuyer, ticketAlive, consumeTicket } from './tickets.mjs'

const TF_INNER_BATCH = 0x40000000

/** Intervalle de fermeture observé sur le Devnet — pour convertir en durée lisible. */
export const SECONDS_PER_LEDGER = 2.88

/**
 * ⭐ L'ÉCHÉANCE DE L'ENGAGEMENT — et pourquoi elle n'est pas sur l'annonce.
 *
 * Une enveloppe sans `LastLedgerSequence` ne meurt jamais. C'est ce qui rend le
 * carnet possible : le vendeur peut confirmer quand il veut. Mais tant que
 * l'acheteur a signé et que le vendeur ne l'a pas fait, le vendeur détient une
 * OPTION GRATUITE — il exécute si ça l'arrange, dans une heure ou dans un an,
 * y compris quand le vault s'est effondré entre-temps. L'acheteur, lui, paie le
 * prix d'hier pour un actif d'aujourd'hui.
 *
 * L'asymétrie est là et nulle part ailleurs :
 *   · l'ANNONCE n'est pas signée, elle n'engage personne → aucune échéance ;
 *   · l'ENGAGEMENT est signé, il donne l'option → il en faut une.
 *
 * Aucun plafond protocolaire (mesuré jusqu'à ~8 ans, sonde 15) : la durée est
 * un choix de produit. 24 h laisse au vendeur le temps de se réveiller sans
 * laisser l'acheteur exposé à un marché qui a bougé.
 */
export const COMMITMENT_LEDGERS = 30_000                       // ≈ 24 h
export const commitmentSeconds = (ledgers = COMMITMENT_LEDGERS) =>
  Math.round(ledgers * SECONDS_PER_LEDGER)

/** L'échéance absolue à inscrire dans l'enveloppe, lue depuis le ledger courant. */
export async function commitmentDeadline(client, ledgers = COMMITMENT_LEDGERS) {
  const r = await client.request({ command: 'ledger', ledger_index: 'validated' })
  const current = r.result.ledger_index
  return { current, lastLedgerSequence: current + ledgers, ledgers }
}

/** L'engagement est-il périmé ? Le ledger tranche, pas l'horloge. */
export function commitmentExpired(batch, currentLedger) {
  const lls = batch?.LastLedgerSequence
  return lls != null && currentLedger != null && currentLedger > lls
}

/** Une jambe interne portée par un ticket : `Sequence` à 0, `TicketSequence` renseigné. */
const leg = (tx, ticket) => ({
  RawTransaction: {
    ...tx, Fee: '0', SigningPubKey: '', Flags: TF_INNER_BATCH,
    Sequence: 0, TicketSequence: Number(ticket),
  },
})

/**
 * L'enveloppe non signée d'une offre durable.
 *
 * `sellerTickets` : [enveloppe, jambe des parts]
 * `buyerTickets`  : [autorisation?, jambe du prix] — l'autorisation d'abord,
 *                   sinon la jambe des parts échoue et tout est annulé.
 *
 * `lls` : l'échéance de l'engagement. `null` = aucune (le Devnet l'accepte,
 * sonde 13/T6) — à ne retenir que si l'acheteur accepte de laisser au vendeur
 * une option gratuite sans fin. Voir `COMMITMENT_LEDGERS`.
 */
export function buildOffer({
  sellerAddress, buyerAddress, mptId, shares, price,
  sellerTickets, buyerTickets, needsAuthorize = true,
  lls = null, flags = BatchFlags.tfAllOrNothing,
}) {
  if (!Array.isArray(sellerTickets) || sellerTickets.length < TICKETS_SELLER)
    throw new RangeError(`le vendeur a besoin de ${TICKETS_SELLER} tickets (enveloppe + jambe)`)
  const besoinAcheteur = ticketsBuyer(needsAuthorize)
  if (!Array.isArray(buyerTickets) || buyerTickets.length < besoinAcheteur)
    throw new RangeError(`l'acheteur a besoin de ${besoinAcheteur} ticket(s)`)

  const amount = normalizeAmount(price)
  const [ticketEnveloppe, ticketParts] = sellerTickets
  const acheteur = [...buyerTickets]

  const inner = []
  if (needsAuthorize)
    inner.push(leg({ TransactionType: 'MPTokenAuthorize', Account: buyerAddress, MPTokenIssuanceID: mptId },
      acheteur.shift()))
  inner.push(leg({ TransactionType: 'Payment', Account: sellerAddress, Destination: buyerAddress,
    Amount: { mpt_issuance_id: mptId, value: String(shares) } }, ticketParts))
  inner.push(leg({ TransactionType: 'Payment', Account: buyerAddress, Destination: sellerAddress,
    Amount: amount.raw }, acheteur.shift()))

  if (inner.length < 2) throw new RangeError('un Batch exige au moins deux jambes (sinon temARRAY_EMPTY)')
  if (inner.length > 8) throw new RangeError(`${inner.length} jambes — le maximum est 8`)

  return {
    TransactionType: 'Batch', Account: sellerAddress, Flags: flags,
    RawTransactions: inner,
    Sequence: 0, TicketSequence: Number(ticketEnveloppe),
    Fee: String(50 * (inner.length + 1)),
    ...(lls == null ? {} : { LastLedgerSequence: Number(lls) }),
  }
}

/** L'acheteur s'engage. Mute `batch` et le renvoie, prêt à être stocké en JSON. */
export function signAsBuyer(batch, buyerWallet) {
  signMultiBatch(buyerWallet, batch)
  return batch
}

/** Le vendeur confirme. À appeler en dernier — c'est le geste qui rend l'offre soumettable. */
export function signAsSeller(batch, sellerWallet) {
  batch.SigningPubKey = sellerWallet.publicKey
  batch.TxnSignature = kpSign(encodeForSigning(batch), sellerWallet.privateKey)
  return batch
}

export const isSignedByBuyer = b => Array.isArray(b?.BatchSigners) && b.BatchSigners.length > 0
export const isSignedBySeller = b => Boolean(b?.TxnSignature)
export const isSubmittable = b => isSignedByBuyer(b) && isSignedBySeller(b)

/** Le ticket de l'enveloppe — celui qu'on consomme pour annuler. */
export const envelopeTicket = b => Number(b?.TicketSequence ?? 0)

/**
 * L'offre est-elle encore vivante ? Une offre dont le ticket d'enveloppe a
 * été consommé ne peut plus être soumise, quoi qu'en dise le carnet.
 */
export function offerAlive(client, batch) {
  return ticketAlive(client, batch.Account, envelopeTicket(batch))
}

/** ⭐ Annuler : le vendeur brûle le ticket de l'enveloppe. 1 drop, opposable. */
export function cancelOffer(client, sellerWallet, batch) {
  return consumeTicket(client, sellerWallet, envelopeTicket(batch))
}

/** Les tickets d'un compte engagés dans ce Batch, dans l'ordre des jambes. */
export function ticketsOf(batch, account) {
  return (batch?.RawTransactions ?? [])
    .map(r => r.RawTransaction)
    .filter(t => t.Account === account)
    .map(t => Number(t.TicketSequence))
    .filter(Boolean)
}

/**
 * ⭐ L'ACHETEUR SE DÉSENGAGE.
 *
 * Une fois ses `BatchSigners` posés, l'acheteur n'avait aucune sortie : le
 * vendeur pouvait confirmer quand bon lui semblait, et rien n'expirait. Le
 * symétrique du bouton du vendeur consiste à brûler l'un de SES tickets —
 * une jambe manquante suffit à rendre le Batch insoumettable.
 *
 * On brûle celui de la jambe du prix (la dernière), pas celui de
 * `MPTokenAuthorize` : l'autorisation, elle, reste utile à l'acheteur.
 */
export function withdrawCommitment(client, buyerWallet, batch) {
  const mine = ticketsOf(batch, buyerWallet.classicAddress)
  if (!mine.length) throw new RangeError('cet acheteur ne porte aucune jambe de ce Batch')
  return consumeTicket(client, buyerWallet, mine[mine.length - 1])
}

/**
 * Soumet et rassemble la preuve. Même discipline que le rail batch : le
 * `tesSUCCESS` d'un `Batch` ne prouve rien, on va rechercher les jambes.
 */
export async function submitOffer(client, batch) {
  if (!isSubmittable(batch))
    return { ok: false, stage: 'signature',
      message: isSignedByBuyer(batch) ? 'le vendeur n\'a pas confirmé' : 'l\'acheteur n\'a pas signé' }

  const sub = await submitBatch(client, batch)
  if (!sub.ok) return { ok: false, stage: 'submit', ...sub }

  const accounts = [...new Set(batch.RawTransactions.map(r => r.RawTransaction.Account))]
  const evidence = await innerResults(client, {
    ledgerIndex: sub.ledgerIndex, accounts, batchHash: sub.hash,
  })
  return {
    ok: evidence.allSucceeded, stage: evidence.allSucceeded ? 'done' : 'silent-failure',
    hash: sub.hash, url: sub.url, batchResult: sub.result, evidence,
  }
}
