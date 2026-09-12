/**
 * @secondwave/settlement — la revente d'une position verrouillée.
 *
 * XLS-65 bloque `VaultWithdraw` pendant toute la phase Investment. La seule
 * sortie possible est de céder les parts elles-mêmes : un Batch atomique qui
 * échange les parts contre le prix, en une transaction ou aucune.
 *
 * Le vrai travail n'est pas le Batch — c'est de savoir s'il a marché.
 * `Batch` renvoie `tesSUCCESS` même lorsque aucune de ses jambes n'a appliqué,
 * et sa meta ne contient pas le `BatchExecutions` annoncé par XLS-56. D'où trois
 * couches :
 *
 *   1. PREFLIGHT   — tout ce qui peut échouer, vérifié avant de dépenser un drop
 *   2. EVIDENCE    — le `BatchExecutions` manquant, reconstruit depuis le ledger
 *   3. RECONCILE   — les soldes avant/après. La seule vérité.
 */
import { BatchFlags, signMultiBatch } from 'xrpl'
import { encode, encodeForSigning } from 'ripple-binary-codec'
import { sign as kpSign } from 'ripple-keypairs'
import {
  readVault, shareBalance, xrpBalance, sequence, isDomainMember, sleep,
  payAmount, SHARE_FLAGS, txUrl,
} from '@secondwave/core'

/** Marque une transaction comme jambe interne d'un Batch. */
const TF_INNER_BATCH = 0x40000000
/** Réserve + frais que l'acheteur doit conserver au-delà du prix. */
const MARGE_ACHETEUR = 2_000_000n

export class SettlementEngine {
  constructor(client) { this.c = client }

  vault(vaultId) { return readVault(this.c, vaultId) }

  // ───────────────────────────────────────────────────────────
  // 1. PREFLIGHT
  // ───────────────────────────────────────────────────────────
  /**
   * Renvoie `{ ok, checks, blockers }`. Chaque `check` est affichable tel quel :
   * c'est ce que l'utilisateur voit avant de confirmer une offre.
   */
  async preflight({ vaultId, seller, buyer, shares, price }) {
    const checks = [], blockers = []
    const ok = (name, detail) => checks.push({ name, ok: true, detail })
    const ko = (name, detail) => { checks.push({ name, ok: false, detail }); blockers.push(`${name}: ${detail}`) }

    const v = await this.vault(vaultId)
    const mptId = v.ShareMPTID
    const flags = Number(v.shares?.Flags ?? 0)
    const domainId = v.shares?.DomainID

    if (flags & SHARE_FLAGS.CAN_TRANSFER) ok('parts transférables', `flags ${flags}`)
    else ko('parts transférables', `flags ${flags} — tfVaultShareNonTransferable : ce vault n'aura jamais de marché secondaire`)

    if (flags & SHARE_FLAGS.REQUIRE_AUTH) ok('vault privé', `RequireAuth actif · domaine ${domainId?.slice(0, 12) ?? '?'}…`)
    else ok('vault public', 'aucune restriction de domaine')

    const m = await isDomainMember(this.c, buyer, domainId)
    m.member ? ok('acheteur éligible', m.reason) : ko('acheteur éligible', m.reason)

    const sb = await shareBalance(this.c, seller, mptId)
    if (sb.amount >= BigInt(shares)) ok('parts du vendeur', `${sb.amount} ≥ ${shares}`)
    else ko('parts du vendeur', `${sb.amount} < ${shares}`)

    const bx = await xrpBalance(this.c, buyer)
    const needed = BigInt(price) + MARGE_ACHETEUR
    if (bx >= needed) ok('trésorerie acheteur', `${bx} drops`)
    else ko('trésorerie acheteur', `${bx} < ${needed} (prix + réserve + frais)`)

    const bb = await shareBalance(this.c, buyer, mptId)
    ok('autorisation acheteur', bb.holds ? 'déjà autorisé — jambe MPTokenAuthorize inutile' : 'à créer dans le batch')

    // ⭐ On ne simule que ce qui est concluant à cet instant.
    // Simuler le transfert alors que l'acheteur n'a pas encore de MPToken
    // renvoie tecNO_AUTH — un faux négatif, puisque le batch l'autorisera en
    // première jambe. Dans ce cas on simule l'autorisation elle-même.
    try {
      const tx_json = bb.holds
        ? { TransactionType: 'Payment', Account: seller, Destination: buyer,
            Amount: { mpt_issuance_id: mptId, value: String(shares) } }
        : { TransactionType: 'MPTokenAuthorize', Account: buyer, MPTokenIssuanceID: mptId }
      const label = bb.holds ? 'simulate transfert de parts' : 'simulate autorisation acheteur'
      const sim = await this.c.request({ command: 'simulate', tx_json })
      const res = sim.result.engine_result
      res === 'tesSUCCESS' ? ok(label, res) : ko(label, `${res} — ${sim.result.engine_result_message ?? ''}`)
    } catch (e) {
      checks.push({ name: 'simulate', ok: null, detail: `indisponible : ${e.data?.error ?? e.message}` })
    }

    return { ok: blockers.length === 0, checks, blockers, mptId, needsAuthorize: !bb.holds, vault: v }
  }

  // ───────────────────────────────────────────────────────────
  // 2. Construction du Batch
  // ───────────────────────────────────────────────────────────
  /**
   * ⚠️ L'autorisation doit précéder la réception, sinon la jambe de transfert
   *    échoue silencieusement.
   * ⚠️ Moins de deux jambes → `temARRAY_EMPTY` (message trompeur).
   * ⚠️ `NetworkID` doit rester absent : network_id ≤ 1024.
   */
  async buildSwap({ vaultId, sellerWallet, buyerWallet, shares, price, mptId, needsAuthorize = true }) {
    const seller = sellerWallet.classicAddress, buyer = buyerWallet.classicAddress
    if (!mptId) mptId = (await this.vault(vaultId)).ShareMPTID

    const sSeq = await sequence(this.c, seller)
    let bSeq = await sequence(this.c, buyer)
    const li = (await this.c.request({ command: 'ledger', ledger_index: 'validated' })).result.ledger_index

    const inner = []
    const leg = t => inner.push({ RawTransaction: { ...t, Fee: '0', SigningPubKey: '', Flags: TF_INNER_BATCH } })

    if (needsAuthorize)
      leg({ TransactionType: 'MPTokenAuthorize', Account: buyer, MPTokenIssuanceID: mptId, Sequence: bSeq++ })
    leg({ TransactionType: 'Payment', Account: seller, Destination: buyer,
          Amount: { mpt_issuance_id: mptId, value: String(shares) }, Sequence: sSeq + 1 })
    leg({ TransactionType: 'Payment', Account: buyer, Destination: seller,
          Amount: String(price), Sequence: bSeq++ })

    const batch = {
      TransactionType: 'Batch', Account: seller, Flags: BatchFlags.tfAllOrNothing,
      RawTransactions: inner, Sequence: sSeq,
      Fee: String(50 * (inner.length + 1)), LastLedgerSequence: li + 25,
    }
    signMultiBatch(buyerWallet, batch)                  // BatchSigners côté acheteur
    batch.SigningPubKey = sellerWallet.publicKey
    batch.TxnSignature = kpSign(encodeForSigning(batch), sellerWallet.privateKey)
    return batch
  }

  // ───────────────────────────────────────────────────────────
  // 2bis. EVIDENCE — le BatchExecutions que rippled ne fournit pas
  // ───────────────────────────────────────────────────────────
  /**
   * La meta du Batch ne contient qu'un seul nœud : la ponction de frais.
   * Les jambes sont des transactions distinctes, dans le même ledger, avec
   * leurs propres hash et résultats — on les retrouve par `account_tx` sur la
   * plage `[ledgerIndex, ledgerIndex]`.
   */
  async innerResults({ ledgerIndex, accounts, batchHash }) {
    const seen = new Map()
    for (const account of accounts) {
      let txs = []
      try {
        txs = (await this.c.request({
          command: 'account_tx', account,
          ledger_index_min: ledgerIndex, ledger_index_max: ledgerIndex, limit: 50,
        })).result.transactions
      } catch { continue }
      for (const t of txs) {
        const tj = t.tx_json ?? t.tx ?? {}
        const hash = t.hash ?? tj.hash
        if (!hash || hash === batchHash || tj.TransactionType === 'Batch') continue
        seen.set(hash, {
          hash, type: tj.TransactionType, account: tj.Account, destination: tj.Destination,
          amount: payAmount(tj), result: t.meta?.TransactionResult,
          nodes: t.meta?.AffectedNodes?.length ?? 0, url: txUrl(hash),
        })
      }
    }
    const legs = [...seen.values()]
    return { legs, allSucceeded: legs.length > 0 && legs.every(l => l.result === 'tesSUCCESS') }
  }

  // ───────────────────────────────────────────────────────────
  // 3. Exécution et réconciliation
  // ───────────────────────────────────────────────────────────
  async executeSwap({ vaultId, sellerWallet, buyerWallet, shares, price, skipPreflight = false }) {
    const seller = sellerWallet.classicAddress, buyer = buyerWallet.classicAddress

    let pre = null
    if (!skipPreflight) {
      pre = await this.preflight({ vaultId, seller, buyer, shares, price })
      if (!pre.ok) return { ok: false, stage: 'preflight', preflight: pre, blockers: pre.blockers }
    }
    const mptId = pre?.mptId ?? (await this.vault(vaultId)).ShareMPTID
    const needsAuthorize = pre ? pre.needsAuthorize : !(await shareBalance(this.c, buyer, mptId)).holds

    const snapshot = async () => ({
      sellerShares: (await shareBalance(this.c, seller, mptId)).amount,
      buyerShares: (await shareBalance(this.c, buyer, mptId)).amount,
      sellerXrp: await xrpBalance(this.c, seller),
      buyerXrp: await xrpBalance(this.c, buyer),
    })
    const before = await snapshot()

    const batch = await this.buildSwap({ vaultId, sellerWallet, buyerWallet, shares, price, mptId, needsAuthorize })
    const sub = await this.c.request({ command: 'submit', tx_blob: encode(batch) })
    const hash = sub.result.tx_json?.hash
    if (sub.result.engine_result !== 'tesSUCCESS')
      return { ok: false, stage: 'submit', engineResult: sub.result.engine_result,
               message: sub.result.engine_result_message, preflight: pre }

    let meta = null, ledgerIndex = null
    for (let i = 0; i < 20; i++) {
      await sleep(2000)
      try {
        const t = await this.c.request({ command: 'tx', transaction: hash })
        if (t.result.validated) { meta = t.result.meta; ledgerIndex = t.result.ledger_index; break }
      } catch { /* pas encore validé */ }
    }
    if (!meta) return { ok: false, stage: 'validation', hash, preflight: pre }

    const evidence = await this.innerResults({ ledgerIndex, accounts: [seller, buyer], batchHash: hash })
    const after = await snapshot()
    const moved = {
      shares: before.sellerShares - after.sellerShares,
      received: after.buyerShares - before.buyerShares,
      paid: before.buyerXrp - after.buyerXrp,
    }
    const reconciled = moved.shares === BigInt(shares) && moved.received === BigInt(shares)

    return {
      ok: reconciled,
      stage: reconciled ? 'done' : 'silent-failure',
      hash, url: txUrl(hash), batchResult: meta?.TransactionResult,
      evidence, before, after, moved, preflight: pre,
      warning: reconciled ? null
        : `Le Batch a renvoyé ${meta?.TransactionResult} mais aucune part n'a bougé — échec silencieux.`,
    }
  }
}

export default SettlementEngine
