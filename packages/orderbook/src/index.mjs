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
 * ⚠️ `cancel()` ne touche QUE ce fichier. Un `Batch` signé continue de circuler
 *    et s'exécute (mesuré). L'annulation opposable est ailleurs : sur une offre
 *    durable, c'est la consommation du ticket d'enveloppe
 *    (`settlement.cancelOffer`, 1 drop, → `tefNO_TICKET`). `cancelDurable()`
 *    ci-dessous fait les deux dans le bon ordre.
 *
 * OFFRE DURABLE — le cycle en quatre temps (voir settlement/durable.mjs) :
 *
 *   post(…, { sellerTickets })   open      personne n'est engagé
 *   match(id, buyer, batch)      matched   l'acheteur a signé, il attend
 *   confirm(id, batch)           armed     le vendeur a signé : soumettable
 *   fill(id, hash)               filled    réglé, preuve on-chain
 *                                cancelled le vendeur a brûlé le ticket
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { readVault, isDomainMember, shareBalance, rippleNow, payAmount, SHARE_FLAGS, txUrl } from '@secondwave/core'

export const STATUS = {
  OPEN: 'open',
  MATCHED: 'matched',     // l'acheteur a signé ses BatchSigners, il attend le vendeur
  ARMED: 'armed',         // le vendeur a confirmé : l'offre est soumettable par quiconque
  FILLED: 'filled',
  CANCELLED: 'cancelled',
  EXPIRED: 'expired',
}

/** Les états où l'offre est encore en cours de vie — ni réglée ni morte. */
export const EN_COURS = [STATUS.OPEN, STATUS.MATCHED, STATUS.ARMED]

export class OrderBook {
  constructor(path = 'orderbook.json') {
    this.path = path
    this.orders = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : []
  }

  save() { writeFileSync(this.path, JSON.stringify(this.orders, null, 2)); return this }

  /**
   * `shares` et `price` sont en unités entières : parts et drops.
   *
   * `sellerTickets` rend l'offre DURABLE : [ticket d'enveloppe, ticket de la
   * jambe des parts]. Sans eux, l'offre reste éphémère (rail batch classique).
   * `ttl: null` = pas d'expiration côté carnet — cohérent avec une enveloppe
   * sans `LastLedgerSequence`.
   */
  post({ vaultId, seller, shares, price, ttl = 3600, sellerTickets = null }) {
    const now = rippleNow()
    const order = {
      id: `o${String(this.orders.length + 1).padStart(3, '0')}`,
      vaultId, seller,
      shares: String(shares),
      price: String(price),
      postedAt: now,
      expiry: ttl == null ? null : now + ttl,
      status: STATUS.OPEN,
      txHash: null,
      durable: Boolean(sellerTickets),
      sellerTickets: sellerTickets ? sellerTickets.map(Number) : null,
      buyer: null,
      batch: null,
    }
    this.orders.push(order)
    this.save()
    return order
  }

  get(id) { return this.orders.find(o => o.id === id) ?? null }

  /** Une offre sans `expiry` ne périme jamais — c'est tout l'intérêt du rail durable. */
  expired(o, now = rippleNow()) { return o.expiry != null && o.expiry <= now }

  /**
   * L'acheteur s'engage : il a signé ses `BatchSigners`. L'offre attend
   * maintenant la confirmation du vendeur, aussi longtemps qu'il faudra.
   */
  match(id, { buyer, batch }) {
    const o = this.get(id)
    if (!o) return { ok: false, reason: 'offre inconnue', order: null }
    if (o.status !== STATUS.OPEN)
      return { ok: false, reason: `offre déjà ${o.status}`, order: o }
    if (this.expired(o)) return { ok: false, reason: 'offre expirée', order: o }
    o.status = STATUS.MATCHED
    o.buyer = buyer
    o.batch = batch
    o.matchedAt = rippleNow()
    this.save()
    return { ok: true, reason: null, order: o }
  }

  /** Le vendeur confirme : il a signé l'enveloppe. L'offre devient soumettable. */
  confirm(id, batch) {
    const o = this.get(id)
    if (!o) return { ok: false, reason: 'offre inconnue', order: null }
    if (o.status !== STATUS.MATCHED)
      return { ok: false, reason: `offre ${o.status} — il n'y a rien à confirmer`, order: o }
    o.status = STATUS.ARMED
    o.batch = batch
    o.confirmedAt = rippleNow()
    this.save()
    return { ok: true, reason: null, order: o }
  }

  /** Marque seulement le fichier. Sur une offre durable, passer par `cancelDurable`. */
  cancel(id) {
    const o = this.get(id)
    if (o && EN_COURS.includes(o.status)) { o.status = STATUS.CANCELLED; o.cancelledAt = rippleNow(); this.save() }
    return o
  }

  /**
   * ⭐ ANNULER POUR DE VRAI.
   *
   * Le vendeur clique « annuler » : on brûle le ticket d'enveloppe, ce qui rend
   * le Batch insoumettable (`tefNO_TICKET`), PUIS on marque le carnet. L'ordre
   * compte — marquer d'abord laisserait une fenêtre où le carnet ment.
   *
   * Un ticket déjà consommé n'est pas une erreur : l'offre était déjà morte.
   */
  /**
   * L'acheteur retire son engagement. Il brûle l'un de ses propres tickets ;
   * l'offre repasse `open`, le vendeur n'a rien perdu — et les tickets du
   * vendeur sont intacts, donc son offre reste publiable telle quelle.
   */
  async withdrawCommitment(client, buyerWallet, id, { withdrawCommitment }) {
    const o = this.get(id)
    if (!o) return { ok: false, reason: 'offre inconnue', order: null }
    if (o.status !== STATUS.MATCHED)
      return { ok: false, reason: `offre « ${o.status} » — aucun engagement à retirer`, order: o }
    if (buyerWallet.classicAddress !== o.buyer)
      return { ok: false, reason: 'seul l\'acheteur engagé peut se retirer', order: o }

    const r = await withdrawCommitment(client, buyerWallet, o.batch)
    if (!r.ok) return { ok: false, reason: `retrait refusé : ${r.result}`, order: o }

    o.status = STATUS.OPEN
    o.buyer = null
    o.batch = null
    o.buyerTickets = null
    o.matchedAt = null
    o.withdrawnAt = rippleNow()
    this.save()
    return { ok: true, hash: r.hash, url: r.url, order: o }
  }

  async cancelDurable(client, sellerWallet, id, { cancelOffer }) {
    const o = this.get(id)
    if (!o) return { ok: false, reason: 'offre inconnue', order: null }
    if (!EN_COURS.includes(o.status))
      return { ok: false, reason: `offre déjà ${o.status}`, order: o }
    if (sellerWallet.classicAddress !== o.seller)
      return { ok: false, reason: 'seul le vendeur peut annuler son offre', order: o }

    const ticket = o.batch?.TicketSequence ?? o.sellerTickets?.[0]
    if (ticket == null) {   // offre éphémère : rien à brûler, le carnet suffit
      this.cancel(id)
      return { ok: true, onChain: false, reason: 'offre non durable — annulation locale seulement', order: o }
    }

    const r = await cancelOffer(client, sellerWallet, { Account: o.seller, TicketSequence: ticket })
    if (!r.ok) return { ok: false, reason: `annulation refusée : ${r.result}`, order: o, onChain: false }

    this.cancel(id)
    return {
      ok: true, onChain: true, alreadyCancelled: Boolean(r.alreadyCancelled),
      hash: r.hash, url: r.url, ticket, order: this.get(id),
    }
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
    // `armed` est l'état normal d'une offre durable au moment du règlement ;
    // `open` reste accepté pour le rail éphémère, qui signe et soumet d'un trait.
    if (o.status !== STATUS.OPEN && o.status !== STATUS.ARMED)
      return { ok: false, reason: `offre déjà ${o.status} (hash conservé : ${o.txHash ?? '—'})`, order: o }
    if (this.expired(o))
      return { ok: false, reason: 'offre expirée', order: o }
    o.status = STATUS.FILLED; o.txHash = txHash; o.filledAt = rippleNow()
    this.save()
    return { ok: true, reason: null, order: o }
  }

  /** Les offres encore achetables. L'expiration est calculée, jamais stockée à l'avance. */
  list(vaultId = null) {
    return this.orders.filter(o =>
      o.status === STATUS.OPEN && !this.expired(o) && (!vaultId || o.vaultId === vaultId))
  }

  /**
   * Toutes les offres qui immobilisent encore des parts : `open`, mais aussi
   * `matched` et `armed`. Une offre engagée n'est plus affichée au carnet et
   * pourtant elle promet des parts — l'oublier, c'est autoriser la survente.
   */
  live(vaultId = null) {
    return this.orders.filter(o =>
      EN_COURS.includes(o.status) && !this.expired(o) && (!vaultId || o.vaultId === vaultId))
  }

  /** Les parts déjà promises par ce vendeur sur ce vault, offre `except` exclue. */
  engagedShares(seller, vaultId, { except = null } = {}) {
    return this.live(vaultId)
      .filter(o => o.seller === seller && o.id !== except)
      .reduce((s, o) => s + BigInt(o.shares), 0n)
  }

  /**
   * ⭐ LE GARDE-FOU DE LA SURVENTE.
   *
   * Un vendeur qui détient 25 M de parts pouvait publier deux offres de 25 M :
   * le carnet les affichait toutes les deux comme vivantes, et la seconde à
   * trouver preneur échouait au règlement. Un échec au règlement est le pire
   * endroit pour découvrir ça — l'acheteur a déjà signé, le vendeur a déjà
   * confirmé, et le Batch part pour rien.
   *
   * `balance` est un BigInt de parts, lu sur la chaîne par l'appelant.
   */
  canOffer({ seller, vaultId, shares, balance, except = null }) {
    const want = BigInt(shares)
    if (want <= 0n) return { ok: false, reason: 'une offre porte sur au moins une part' }
    const engaged = this.engagedShares(seller, vaultId, { except })
    const libre = BigInt(balance) - engaged
    if (want > libre) {
      return {
        ok: false, engaged, free: libre, balance: BigInt(balance),
        reason: engaged === 0n
          ? `le vendeur ne détient que ${balance} parts`
          : `${engaged} parts déjà promises sur ${this.live(vaultId).filter(o => o.seller === seller && o.id !== except).length} `
            + `offre(s) en cours — il en reste ${libre} de libres sur ${balance}`,
      }
    }
    return { ok: true, engaged, free: libre, balance: BigInt(balance), reason: null }
  }

  /**
   * La file d'attente d'un vendeur : ce sur quoi on lui demande de se prononcer.
   * C'est ce que l'interface affiche derrière la notification « quelqu'un veut
   * acheter votre offre ».
   */
  pending(seller) {
    return this.orders.filter(o => o.seller === seller && o.status === STATUS.MATCHED)
  }

  /** Les offres confirmées par le vendeur et pas encore soumises. */
  armed(seller = null) {
    return this.orders.filter(o => o.status === STATUS.ARMED && (!seller || o.seller === seller))
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
    // ⚠️ La couverture se calcule sur TOUTES les offres vivantes, pas seulement
    //    celles encore affichées : une offre `matched` promet déjà ses parts.
    const vivantes = this.live(vaultId)
    const vaults = new Map()
    for (const o of vivantes)
      if (!vaults.has(o.vaultId)) vaults.set(o.vaultId, await readVault(client, o.vaultId))

    // Soldes réels des vendeurs, une lecture par couple (vendeur, vault).
    const balances = new Map()
    for (const o of vivantes) {
      const key = `${o.seller}|${o.vaultId}`
      if (!balances.has(key))
        balances.set(key, (await shareBalance(client, o.seller, vaults.get(o.vaultId).ShareMPTID)).amount)
    }

    // ⭐ Couverture CUMULÉE (bug F48) : le solde d'un vendeur est alloué à ses
    //    offres dans l'ordre de publication. Au-delà, l'offre est découverte —
    //    l'ancienne version les affichait toutes comme honorables.
    const coverage = allocateCoverage(vivantes, balances)

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
