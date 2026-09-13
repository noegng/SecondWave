/**
 * Les Tickets — ce qui rend une offre signée durable.
 *
 * Un `Batch` fige les `Sequence` des deux comptes dans ce que chacun signe.
 * Tant qu'une offre est portée par des séquences, elle meurt dès que l'un des
 * deux fait autre chose : impossible de signer maintenant et de soumettre plus
 * tard. C'est la différence entre un carnet d'ordres et une poignée de main.
 *
 * Un Ticket est une séquence réservée d'avance : la transaction qui le porte
 * ne dépend plus de l'activité du compte. Mesuré sur le Devnet
 * (`probes-marche/13-tickets-et-batch.mjs`, 7 cas) :
 *
 *   · `TicketSequence` est accepté sur l'enveloppe ET sur les jambes internes ;
 *   · une offre pré-signée survit à des transactions des DEUX comptes ;
 *   · `LastLedgerSequence` peut être allongé, ou omis — aucune expiration.
 *
 * Contrepartie, et elle compte : le vendeur perd l'annulation par bump de
 * séquence. Le remplaçant est `consumeTicket()` — voir
 * `probes-marche/14-annulation-par-ticket.mjs` (C1 : `tefNO_TICKET`).
 *
 * ⚠️ Chaque Ticket immobilise une part de la réserve du propriétaire, et un
 *    compte ne peut pas en détenir plus de 250 à la fois.
 */
import { submit } from '@secondwave/core'

/** Le plafond protocolaire de Tickets détenus simultanément par un compte. */
export const MAX_TICKETS = 250

/** Tickets d'une offre : enveloppe + jambe du vendeur, puis les jambes de l'acheteur. */
export const TICKETS_SELLER = 2
export const ticketsBuyer = (needsAuthorize = true) => (needsAuthorize ? 2 : 1)

/** Les `TicketSequence` que ce compte détient, dans l'ordre croissant. */
export async function listTickets(client, account) {
  const r = await client.request({
    command: 'account_objects', account, type: 'ticket', ledger_index: 'validated',
  })
  return (r.result.account_objects ?? [])
    .map(o => o.TicketSequence)
    .sort((a, b) => a - b)
}

/**
 * Garantit au moins `want` tickets libres, en n'en créant que le complément.
 * `reserved` : ceux déjà promis à des offres ouvertes — ils ne comptent pas
 * comme libres, sinon deux offres se battraient pour le même.
 */
export async function ensureTickets(client, wallet, want, { reserved = [] } = {}) {
  const account = wallet.classicAddress
  const held = await listTickets(client, account)
  const taken = new Set(reserved.map(Number))
  const free = held.filter(t => !taken.has(t))
  if (free.length >= want) return { free, created: 0, result: null }

  const missing = want - free.length
  if (held.length + missing > MAX_TICKETS)
    throw new RangeError(
      `${account} détient ${held.length} tickets — en créer ${missing} dépasserait le plafond de ${MAX_TICKETS}.`)

  const r = await submit(client, {
    TransactionType: 'TicketCreate', Account: account, TicketCount: missing,
  }, wallet)
  if (!r.ok) return { free, created: 0, result: r.result, message: r.message, ok: false }

  const after = await listTickets(client, account)
  return { free: after.filter(t => !taken.has(t)), created: missing, result: r.result, ok: true }
}

/**
 * ⭐ L'ANNULATION OPPOSABLE.
 *
 * Détruit un ticket en le consommant par une transaction vide. Tout ce qui
 * était signé sur ce ticket devient insoumettable — `tefNO_TICKET`, mesuré.
 * C'est la seule annulation que le ledger fait respecter : marquer une offre
 * « annulée » dans un fichier n'empêche personne de rejouer un Batch signé.
 *
 * Coût mesuré : 1 drop. Idempotent en pratique — une seconde annulation du
 * même ticket échoue elle aussi en `tefNO_TICKET`, à traduire par « déjà
 * annulée » plutôt qu'en erreur.
 */
export async function consumeTicket(client, wallet, ticketSequence) {
  const r = await submit(client, {
    TransactionType: 'AccountSet', Account: wallet.classicAddress,
    Sequence: 0, TicketSequence: Number(ticketSequence),
  }, wallet)
  const dejaFait = !r.ok && /tefNO_TICKET/.test(`${r.result} ${r.message ?? ''}`)
  return {
    ok: r.ok || dejaFait,
    alreadyCancelled: dejaFait && !r.ok,
    result: r.result, message: r.message ?? null, hash: r.hash ?? null, url: r.url ?? null,
  }
}

/** Le ticket existe-t-il encore ? Une offre dont le ticket a sauté est morte. */
export async function ticketAlive(client, account, ticketSequence) {
  const held = await listTickets(client, account)
  return held.includes(Number(ticketSequence))
}
