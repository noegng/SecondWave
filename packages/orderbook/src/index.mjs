/**
 * @secondwave/orderbook — le carnet d'offres de positions verrouillées.
 *
 * Le carnet est hors chaîne, volontairement : une offre n'engage rien tant
 * qu'elle n'est pas acceptée, et XLS-65 n'offre aucune primitive de mise en
 * vente. Seule l'exécution touche le ledger (voir @secondwave/settlement).
 *
 * Ce que le carnet apporte au-dessus d'un simple tableau :
 *   · il n'affiche à un acheteur que ce qu'il peut réellement recevoir ;
 *   · il relit les prix des transactions passées directement sur la chaîne.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { readVault, isDomainMember, shareBalance, rippleNow, payAmount, SHARE_FLAGS, txUrl } from '@secondwave/core'

export const STATUS = { OPEN: 'open', FILLED: 'filled', CANCELLED: 'cancelled', EXPIRED: 'expired' }

export class OrderBook {
  constructor(path = 'orderbook.json') {
    this.path = path
    this.orders = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : []
  }

  save() { writeFileSync(this.path, JSON.stringify(this.orders, null, 2)); return this }

  /** `shares` et `price` sont en unités entières : parts et drops. */
  post({ vaultId, seller, shares, price, ttl = 3600 }) {
    const order = {
      id: `o${String(this.orders.length + 1).padStart(3, '0')}`,
      vaultId, seller,
      shares: String(shares),
      price: String(price),
      postedAt: rippleNow(),
      expiry: rippleNow() + ttl,
      status: STATUS.OPEN,
      txHash: null,
    }
    this.orders.push(order)
    this.save()
    return order
  }

  get(id) { return this.orders.find(o => o.id === id) ?? null }

  cancel(id) {
    const o = this.get(id)
    if (o && o.status === STATUS.OPEN) { o.status = STATUS.CANCELLED; this.save() }
    return o
  }

  /** Marque une offre exécutée et garde le hash — la preuve on-chain du prix. */
  fill(id, txHash) {
    const o = this.get(id)
    if (o) { o.status = STATUS.FILLED; o.txHash = txHash; o.filledAt = rippleNow(); this.save() }
    return o
  }

  /** Les offres encore vivantes. L'expiration est calculée, jamais stockée à l'avance. */
  list(vaultId = null) {
    const now = rippleNow()
    return this.orders.filter(o =>
      o.status === STATUS.OPEN && o.expiry > now && (!vaultId || o.vaultId === vaultId))
  }

  /**
   * ⭐ Le carnet vu par un acheteur donné.
   *
   * Une offre inaccessible n'est pas masquée mais annotée : savoir *pourquoi*
   * on ne peut pas acheter vaut mieux qu'une liste vide — c'est en général un
   * credential manquant, et c'est réparable.
   */
  async viewFor(client, buyer, vaultId = null) {
    const out = []
    const cache = new Map()
    for (const o of this.list(vaultId)) {
      if (!cache.has(o.vaultId)) cache.set(o.vaultId, await readVault(client, o.vaultId))
      const v = cache.get(o.vaultId)
      const flags = Number(v.shares?.Flags ?? 0)

      let eligible = true, reason = 'accessible'
      if (!(flags & SHARE_FLAGS.CAN_TRANSFER)) {
        eligible = false; reason = 'parts non transférables — ce vault n\'a pas de marché secondaire'
      } else {
        const m = await isDomainMember(client, buyer, v.shares?.DomainID)
        if (!m.member) { eligible = false; reason = m.reason }
      }

      // Une offre dont le vendeur s'est déjà défait de ses parts est morte.
      const sb = await shareBalance(client, o.seller, v.ShareMPTID)
      const couverte = sb.amount >= BigInt(o.shares)
      if (eligible && !couverte) { eligible = false; reason = `le vendeur n'a plus que ${sb.amount} parts` }

      out.push({ ...o, eligible, reason, pricePerShare: Number(o.price) / Number(o.shares) })
    }
    return out
  }
}

/**
 * ⭐ L'historique des prix, relu sur la chaîne.
 *
 * Rien n'enregistre un « prix » : un swap est un Payment de parts et un Payment
 * d'XRP en sens inverse, dans le même Batch donc dans le même ledger. On lit
 * les transferts de parts depuis le pseudo-compte du vault, puis on va chercher
 * la contrepartie en numéraire dans le même ledger.
 */
export async function priceHistory(client, vaultId, { maxPages = 10 } = {}) {
  const v = await readVault(client, vaultId)
  const mptId = v.ShareMPTID
  const transfers = []

  let marker, pages = 0
  do {
    const r = await client.request({
      command: 'account_tx', account: v.Account,
      ledger_index_min: -1, ledger_index_max: -1, limit: 200, forward: true,
      ...(marker ? { marker } : {}),
    })
    for (const t of r.result.transactions) {
      const tx = t.tx_json ?? t.tx ?? {}
      if (t.meta?.TransactionResult !== 'tesSUCCESS') continue
      if (tx.TransactionType !== 'Payment') continue
      const amount = payAmount(tx)
      if (amount?.mpt_issuance_id !== mptId) continue
      transfers.push({
        ledgerIndex: t.ledger_index, hash: t.hash ?? tx.hash,
        seller: tx.Account, buyer: tx.Destination, shares: BigInt(amount.value),
        closeTime: t.close_time_iso,
      })
    }
    marker = r.result.marker; pages++
  } while (marker && pages < maxPages)

  const trades = []
  for (const tr of transfers) {
    const price = await counterLeg(client, tr)
    trades.push({
      ...tr, shares: tr.shares.toString(), price: price?.toString() ?? null,
      pricePerShare: price ? Number(price) / Number(tr.shares) : null,
      url: txUrl(tr.hash),
    })
  }
  return trades
}

/** Le Payment en XRP de l'acheteur vers le vendeur, dans le même ledger. */
async function counterLeg(client, { ledgerIndex, buyer, seller }) {
  try {
    const r = await client.request({
      command: 'account_tx', account: buyer,
      ledger_index_min: ledgerIndex, ledger_index_max: ledgerIndex, limit: 50,
    })
    for (const t of r.result.transactions) {
      const tx = t.tx_json ?? t.tx ?? {}
      if (tx.TransactionType !== 'Payment') continue
      if (tx.Account !== buyer || tx.Destination !== seller) continue
      const amount = payAmount(tx)
      if (typeof amount !== 'string') continue             // XRP uniquement
      if (t.meta?.TransactionResult !== 'tesSUCCESS') continue
      return BigInt(amount)
    }
  } catch { /* compte illisible */ }
  return null
}

export default OrderBook
