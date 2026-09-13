/**
 * apps/web/api.mjs — le rail durable, exposé à l'interface.
 *
 * Les quatre gestes du carnet, dans l'ordre où ils arrivent :
 *
 *   POST /api/offers              le vendeur publie      → open
 *   POST /api/offers/:id/take     l'acheteur s'engage    → matched
 *   POST /api/offers/:id/confirm  le vendeur confirme    → armed puis filled
 *   POST /api/offers/:id/cancel   le vendeur annule      → cancelled (ticket brûlé)
 *
 * 🔴 MODÈLE DE CONFIANCE — À LIRE AVANT DE SERVIR CECI AILLEURS QUE SUR
 *    localhost. Ce serveur signe avec les seeds de `state.json`, exactement
 *    comme la CLI. C'est un choix de démonstration : l'extension XRPL Dev
 *    Wallet ne connaît pas le type `Batch` (aucune occurrence dans son source),
 *    donc aucun wallet ne peut aujourd'hui poser des `BatchSigners`. Le jour où
 *    elle le saura, `take` et `confirm` renverront la transaction à signer au
 *    lieu de la signer ici — la forme des routes ne changera pas.
 *
 *    En attendant : ne pas exposer ce serveur sur le réseau.
 */
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { connect, Wallet, shareBalance } from '@secondwave/core'
import {
  ensureTickets, TICKETS_SELLER, ticketsBuyer,
  buildOffer, signAsBuyer, signAsSeller, submitOffer,
  cancelOffer, withdrawCommitment, offerAlive,
} from '@secondwave/settlement'
import { OrderBook, STATUS, EN_COURS } from '@secondwave/orderbook'

export class ApiError extends Error {
  constructor(code, message) { super(message); this.code = code }
}

/** Le carnet est relu à chaque appel : la CLI et l'interface écrivent le même fichier. */
export function createApi(repo) {
  const bookPath = join(repo, 'orderbook.json')
  let client = null
  let acteurs = null   // adresse → Wallet, chargé paresseusement depuis state.json

  const book = () => new OrderBook(bookPath)

  async function xrpl() {
    if (!client?.isConnected()) {
      const world = JSON.parse(await readFile(join(repo, 'world.json'), 'utf8'))
      client = await connect(world.network)
    }
    return client
  }

  /**
   * L'annuaire des signataires. Sans `state.json`, l'interface reste consultable
   * mais aucun geste signé n'est possible — et on le dit clairement.
   */
  async function signataires() {
    if (acteurs) return acteurs
    const p = join(repo, 'state.json')
    if (!existsSync(p))
      throw new ApiError('no-state', 'state.json absent — lancer `npm run world`. Lecture seule en attendant.')
    const s = JSON.parse(await readFile(p, 'utf8'))
    const m = new Map()
    const add = seed => { const w = Wallet.fromSeed(seed); m.set(w.classicAddress, w) }
    add(s.issuer); add(s.nonMember)
    for (const v of Object.values(s.vaults)) {
      add(v.owner); v.depositors.forEach(add); v.borrowers.forEach(add)
    }
    acteurs = m
    return m
  }

  async function walletDe(address) {
    const w = (await signataires()).get(address)
    if (!w) throw new ApiError('no-seed',
      `${address} n'a pas de seed locale — ce compte ne peut pas signer ici. `
      + `Les wallets invités peuvent détenir des parts, pas signer un Batch.`)
    return w
  }

  async function vaultDe(vaultId) {
    const world = JSON.parse(await readFile(join(repo, 'world.json'), 'utf8'))
    const v = world.vaults.find(x => x.vaultId === vaultId || x.key === vaultId)
    if (!v) throw new ApiError('no-vault', `vault inconnu : ${vaultId}`)
    return v
  }

  /** Les tickets déjà promis à des offres en cours — ils ne sont pas libres. */
  function engages(b, account) {
    return b.orders
      .filter(o => EN_COURS.includes(o.status))
      .flatMap(o => (o.seller === account ? (o.sellerTickets ?? []) : [])
        .concat(o.buyer === account ? (o.buyerTickets ?? []) : []))
  }

  /** Une offre allégée pour l'interface : jamais le Batch signé, qui est volumineux. */
  const publique = o => ({
    id: o.id, vaultId: o.vaultId, seller: o.seller, buyer: o.buyer ?? null,
    shares: o.shares, price: o.price, status: o.status,
    postedAt: o.postedAt, expiry: o.expiry, matchedAt: o.matchedAt ?? null,
    confirmedAt: o.confirmedAt ?? null, filledAt: o.filledAt ?? null,
    txHash: o.txHash ?? null, durable: Boolean(o.durable),
    signedByBuyer: Boolean(o.batch?.BatchSigners?.length),
    signedBySeller: Boolean(o.batch?.TxnSignature),
  })

  return {
    /**
     * Tout le carnet, plus les deux files d'attente du compte qui regarde :
     * ce qu'on lui demande de confirmer (vendeur) et ce sur quoi il s'est
     * engagé (acheteur).
     */
    async list({ account = null } = {}) {
      const b = book()
      return {
        offers: b.orders.map(publique),
        pending: account ? b.pending(account).map(publique) : [],
        commitments: account
          ? b.orders.filter(o => o.buyer === account && o.status === STATUS.MATCHED).map(publique)
          : [],
        canSign: existsSync(join(repo, 'state.json')),
      }
    },

    /** ① Le vendeur publie. Rien n'est signé : on réserve seulement ses tickets. */
    async post({ seller, vaultId, shares, price }) {
      const b = book()
      const v = await vaultDe(vaultId)
      const w = await walletDe(seller)
      const c = await xrpl()

      // ⭐ Survente : on compte les parts DÉJÀ promises par ce vendeur sur ce
      //    vault, offres engagées comprises. Sans ça, 25 M de parts autorisent
      //    deux annonces de 25 M, et la seconde meurt au règlement.
      const bal = await shareBalance(c, seller, v.shareMptId)
      const garde = b.canOffer({ seller, vaultId: v.vaultId, shares, balance: bal.amount })
      if (!garde.ok) throw new ApiError('insufficient', garde.reason)

      const t = await ensureTickets(c, w, TICKETS_SELLER, { reserved: engages(b, seller) })
      if (t.ok === false) throw new ApiError('ticket', `TicketCreate : ${t.result} ${t.message ?? ''}`)

      const o = b.post({
        vaultId: v.vaultId, seller, shares: String(shares), price: String(price),
        ttl: null, sellerTickets: t.free.slice(0, TICKETS_SELLER),
      })
      return {
        offer: publique(o), ticketsCreated: t.created,
        free: (garde.free - BigInt(shares)).toString(), balance: garde.balance.toString(),
      }
    },

    /**
     * Ce qu'un vendeur peut encore proposer sur un vault — l'interface s'en sert
     * pour plafonner le curseur AVANT que le bouton ne soit cliquable.
     */
    async capacity({ seller, vaultId }) {
      const b = book()
      const v = await vaultDe(vaultId)
      const c = await xrpl()
      const bal = await shareBalance(c, seller, v.shareMptId)
      const engaged = b.engagedShares(seller, v.vaultId)
      return {
        balance: bal.amount.toString(),
        engaged: engaged.toString(),
        free: (bal.amount - engaged > 0n ? bal.amount - engaged : 0n).toString(),
        offers: b.live(v.vaultId).filter(o => o.seller === seller).map(publique),
      }
    },

    /** ② L'acheteur s'engage : ses BatchSigners, puis l'offre attend le vendeur. */
    async take({ id, buyer }) {
      const b = book()
      const o = b.get(id)
      if (!o) throw new ApiError('no-offer', `offre inconnue : ${id}`)
      if (o.status !== STATUS.OPEN) throw new ApiError('state', `offre déjà « ${o.status} »`)
      if (!o.durable) throw new ApiError('state', 'offre non durable — elle ne se prend pas en deux temps')
      if (buyer === o.seller) throw new ApiError('self', 'on ne rachète pas sa propre offre')

      const v = await vaultDe(o.vaultId)
      const w = await walletDe(buyer)
      const c = await xrpl()

      const bal = await shareBalance(c, buyer, v.shareMptId)
      const needsAuthorize = !bal.holds
      const need = ticketsBuyer(needsAuthorize)
      const t = await ensureTickets(c, w, need, { reserved: engages(b, buyer) })
      if (t.ok === false) throw new ApiError('ticket', `TicketCreate : ${t.result} ${t.message ?? ''}`)
      const buyerTickets = t.free.slice(0, need)

      const batch = buildOffer({
        sellerAddress: o.seller, buyerAddress: buyer, mptId: v.shareMptId,
        shares: o.shares, price: o.price,
        sellerTickets: o.sellerTickets, buyerTickets, needsAuthorize,
      })
      signAsBuyer(batch, w)

      o.buyerTickets = buyerTickets
      const m = b.match(id, { buyer, batch })
      if (!m.ok) throw new ApiError('state', m.reason)
      b.save()
      return { offer: publique(b.get(id)), needsAuthorize }
    },

    /** ③ Le vendeur confirme, et ça règle. C'est le seul geste qui dépense. */
    async confirm({ id, seller }) {
      const b = book()
      const o = b.get(id)
      if (!o) throw new ApiError('no-offer', `offre inconnue : ${id}`)
      if (o.status !== STATUS.MATCHED) throw new ApiError('state', `offre « ${o.status} » — rien à confirmer`)
      if (seller && seller !== o.seller) throw new ApiError('forbidden', 'seul le vendeur confirme son offre')

      const w = await walletDe(o.seller)
      const c = await xrpl()

      // Le vendeur a pu annuler depuis la CLI entre-temps : le ledger tranche.
      if (!await offerAlive(c, o.batch)) {
        b.cancel(id)
        throw new ApiError('cancelled', 'le ticket a été consommé — cette offre est déjà annulée')
      }

      signAsSeller(o.batch, w)
      b.confirm(id, o.batch)
      const r = await submitOffer(c, o.batch)
      if (!r.ok)
        return { offer: publique(b.get(id)), settled: false, stage: r.stage,
                 message: r.message ?? r.engineResult ?? r.batchResult ?? null }

      b.fill(id, r.hash)
      return {
        offer: publique(b.get(id)), settled: true,
        hash: r.hash, url: r.url, batchResult: r.batchResult,
        legs: r.evidence.legs.map(l => ({ type: l.type, result: l.result, hash: l.hash, url: l.url })),
      }
    },

    /**
     * ③ bis — l'acheteur se retire. Symétrique du bouton du vendeur : il brûle
     * l'un de SES tickets, l'offre repasse `open` et le vendeur récupère la
     * main sans avoir rien dépensé.
     */
    async unmatch({ id, buyer }) {
      const b = book()
      const o = b.get(id)
      if (!o) throw new ApiError('no-offer', `offre inconnue : ${id}`)
      if (!o.buyer) throw new ApiError('state', `offre « ${o.status} » — aucun acheteur engagé à retirer`)
      if (buyer && buyer !== o.buyer) throw new ApiError('forbidden', 'seul l\'acheteur engagé peut se retirer')

      const w = await walletDe(o.buyer)
      const c = await xrpl()
      const r = await b.withdrawCommitment(c, w, id, { withdrawCommitment })
      if (!r.ok) throw new ApiError('withdraw', r.reason)
      return { offer: publique(b.get(id)), hash: r.hash ?? null, url: r.url ?? null }
    },

    /** ④ Annuler — un clic côté vendeur, un ticket brûlé côté ledger. */
    async cancel({ id, seller }) {
      const b = book()
      const o = b.get(id)
      if (!o) throw new ApiError('no-offer', `offre inconnue : ${id}`)
      if (seller && seller !== o.seller) throw new ApiError('forbidden', 'seul le vendeur annule son offre')

      const w = await walletDe(o.seller)
      const c = await xrpl()
      const r = await b.cancelDurable(c, w, id, { cancelOffer })
      if (!r.ok) throw new ApiError('cancel', r.reason)
      return {
        offer: publique(b.get(id)), onChain: Boolean(r.onChain),
        alreadyCancelled: Boolean(r.alreadyCancelled),
        ticket: r.ticket ?? null, hash: r.hash ?? null, url: r.url ?? null,
      }
    },
  }
}
