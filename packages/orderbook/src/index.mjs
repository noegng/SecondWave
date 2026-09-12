/**
 * @secondwave/orderbook — le carnet d'offres de positions verrouillées.
 *
 * Le carnet est hors chaîne, volontairement : une offre n'engage rien tant
 * qu'elle n'est pas acceptée, et XLS-65 n'offre aucune primitive de mise en
 * vente. Seule l'exécution touche le ledger (voir @secondwave/settlement).
 *
 * Ce que le carnet apporte au-dessus d'un simple tableau :
 *   · il n'affiche à un acheteur que ce qu'il peut réellement recevoir ;
 *   · il relit les prix des transactions passées directement sur la chaîne ;
 *   · il refuse d'afficher comme vivante une offre que le vendeur ne peut plus
 *     honorer — y compris quand ce sont SES AUTRES offres qui l'en empêchent.
 *
 * ⚠️ Ce carnet ne peut pas annuler une offre déjà signée. Un `cancel()` ne
 *    touche que ce fichier ; un `Batch` signé continue de circuler et s'exécute
 *    (mesuré). La seule annulation opposable est un bump de séquence du vendeur
 *    (`AccountSet` à vide, 10 drops) : voir `settlement/RAILS.md`.
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

  /**
   * Marque une offre exécutée et garde le hash — la preuve on-chain du prix.
   *
   * ⭐ Garde de statut (bug F51) : sans elle, deux règlements concurrents
   *    écrasaient l'un l'autre et le `txHash` du vrai acheteur — celui dont le
   *    Batch a été validé — était remplacé par celui du perdant (`tefPAST_SEQ`).
   *    Une offre déjà exécutée, annulée ou expirée ne se remplit plus.
   */
  fill(id, txHash) {
    const o = this.get(id)
    if (!o) return { ok: false, reason: 'offre inconnue', order: null }
    if (o.status !== STATUS.OPEN)
      return { ok: false, reason: `offre déjà ${o.status} (hash conservé : ${o.txHash ?? '—'})`, order: o }
    if (o.expiry <= rippleNow())
      return { ok: false, reason: 'offre expirée', order: o }
    o.status = STATUS.FILLED; o.txHash = txHash; o.filledAt = rippleNow()
    this.save()
    return { ok: true, reason: null, order: o }
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
    const open = this.list(vaultId)
    const vaults = new Map()
    for (const o of open)
      if (!vaults.has(o.vaultId)) vaults.set(o.vaultId, await readVault(client, o.vaultId))

    // Soldes réels des vendeurs, une lecture par couple (vendeur, vault).
    const balances = new Map()
    for (const o of open) {
      const key = `${o.seller}|${o.vaultId}`
      if (!balances.has(key))
        balances.set(key, (await shareBalance(client, o.seller, vaults.get(o.vaultId).ShareMPTID)).amount)
    }

    // ⭐ Couverture CUMULÉE (bug F48) : le solde d'un vendeur est alloué à ses
    //    offres dans l'ordre de publication. Au-delà, l'offre est découverte —
    //    l'ancienne version les affichait toutes comme honorables.
    const coverage = allocateCoverage(open, balances)

    const out = []
    for (const o of open) {
      const v = vaults.get(o.vaultId)
      const flags = Number(v.shares?.Flags ?? 0)
      const cov = coverage.get(o.id)

      let eligible = true, reason = 'accessible'
      if (!(flags & SHARE_FLAGS.CAN_TRANSFER)) {
        eligible = false; reason = 'parts non transférables — ce vault n\'a pas de marché secondaire'
      } else {
        const m = await isDomainMember(client, buyer, v.shares?.DomainID)
        if (!m.member) { eligible = false; reason = m.reason }
      }
      if (eligible && !cov.covered) { eligible = false; reason = cov.reason }

      out.push({
        ...o, eligible, reason,
        covered: cov.covered, sellerBalance: cov.balance.toString(),
        pricePerShare: Number(o.price) / Number(o.shares),
      })
    }
    return out
  }
}

/**
 * Alloue le solde de chaque vendeur à ses offres, dans l'ordre de publication.
 * Fonction pure — c'est elle qui est testée hors ligne.
 *
 * @param orders   offres ouvertes `{ id, seller, vaultId, shares, postedAt }`
 * @param balances Map `"vendeur|vault" → bigint`
 * @returns Map `id → { covered, balance, engagedBefore, reason }`
 */
export function allocateCoverage(orders, balances) {
  const out = new Map()
  const engaged = new Map()
  const ordered = [...orders].sort((a, b) => (a.postedAt - b.postedAt) || a.id.localeCompare(b.id))

  for (const o of ordered) {
    const key = `${o.seller}|${o.vaultId}`
    const balance = BigInt(balances.get(key) ?? 0n)
    const before = engaged.get(key) ?? 0n
    const want = BigInt(o.shares)
    const covered = before + want <= balance
    if (covered) engaged.set(key, before + want)
    out.set(o.id, {
      covered, balance, engagedBefore: before,
      reason: covered ? 'accessible'
        : before === 0n
          ? `le vendeur n'a plus que ${balance} parts`
          : `couverture cumulée dépassée : ${before} parts déjà engagées sur d'autres offres, `
            + `${balance} au solde, ${want} demandées ici`,
    })
  }
  return out
}

/**
 * ⭐ L'historique des prix, relu sur la chaîne.
 *
 * Rien n'enregistre un « prix » : un swap est un Payment de parts et un Payment
 * en sens inverse, dans le même Batch donc dans le même ledger. On lit les
 * transferts de parts depuis le pseudo-compte du vault, puis on va chercher la
 * contrepartie dans le même ledger — en XRP, en IOU ou en MPT.
 *
 * Compatibilité : `price` reste la chaîne de drops pour un prix en XRP (et
 * `null` sinon) ; `priceAmount` / `priceLabel` / `priceKind` portent les autres
 * numéraires.
 *
 * ⚠️ Deux limites assumées, mesurées :
 *   · un règlement étalé sur DEUX ledgers n'est pas recollé (on ne regarde que
 *     le ledger du transfert de parts) ;
 *   · le coût est d'un `account_tx` PAR transfert — O(n) en RPC.
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
    const paid = await counterLeg(client, tr)
    trades.push({
      ...tr, shares: tr.shares.toString(),
      // — compat : les consommateurs existants lisent `price` en drops —
      price: paid?.kind === 'XRP' ? paid.value : null,
      pricePerShare: paid ? Number(paid.value) / Number(tr.shares) : null,
      priceKind: paid?.kind ?? null,
      priceAmount: paid?.raw ?? null,
      priceLabel: paid ? paid.label : null,
      url: txUrl(tr.hash),
    })
  }
  return trades
}

/**
 * Le paiement de l'acheteur vers le vendeur, dans le même ledger — quel qu'en
 * soit le numéraire. Renvoie `{ kind, value, raw, label }` ou null.
 */
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
      if (t.meta?.TransactionResult !== 'tesSUCCESS') continue
      const amount = payAmount(tx)
      if (typeof amount === 'string')
        return { kind: 'XRP', value: amount, raw: amount, label: `${(Number(amount) / 1e6).toFixed(6)} XRP` }
      if (amount?.mpt_issuance_id)
        return { kind: 'MPT', value: String(amount.value), raw: amount,
                 label: `${amount.value} unités de ${String(amount.mpt_issuance_id).slice(0, 8)}…` }
      if (amount?.currency)
        return { kind: 'IOU', value: String(amount.value), raw: amount,
                 label: `${amount.value} ${amount.currency}.${String(amount.issuer).slice(0, 6)}…` }
    }
  } catch { /* compte illisible */ }
  return null
}

export default OrderBook
