/**
 * RAIL « batch » — l'échange en une transaction.
 *
 * Trois jambes dans un `Batch tfAllOrNothing` :
 *   1. MPTokenAuthorize (acheteur)   ← DOIT être en premier, sinon la jambe 2
 *                                      échoue et tout est annulé
 *   2. Payment des parts  (vendeur → acheteur)
 *   3. Payment du prix    (acheteur → vendeur)
 *
 * ⚠️ Moins de deux jambes → `temARRAY_EMPTY` (« Array is empty », trompeur).
 * ⚠️ Plus de huit jambes → rejet local `invalidTransaction`.
 * ⚠️ `NetworkID` doit rester absent : network_id ≤ 1024.
 * ⚠️ L'enveloppe est portée par le VENDEUR, délibérément : sa séquence
 *    sérialise les ventes concurrentes (`tefPAST_SEQ`, échec visible) et lui
 *    donne un droit d'annulation réel (bump de séquence à 10 drops). Une
 *    enveloppe côté acheteur rendrait les mêmes courses silencieuses.
 */
import { BatchFlags, signMultiBatch } from 'xrpl'
import { encode, encodeForSigning } from 'ripple-binary-codec'
import { sign as kpSign } from 'ripple-keypairs'
import { sequence, sleep, payAmount, txUrl } from '@secondwave/core'
import { normalizeAmount } from './amounts.mjs'

const TF_INNER_BATCH = 0x40000000

/** Construit et signe le Batch de swap. `price` accepte XRP, IOU ou MPT. */
export async function buildSwap(client, {
  sellerWallet, buyerWallet, mptId, shares, price, needsAuthorize = true,
  flags = BatchFlags.tfAllOrNothing,
}) {
  const seller = sellerWallet.classicAddress, buyer = buyerWallet.classicAddress
  const amount = normalizeAmount(price)

  const sSeq = await sequence(client, seller)
  let bSeq = await sequence(client, buyer)
  const li = (await client.request({ command: 'ledger', ledger_index: 'validated' })).result.ledger_index

  const inner = []
  const leg = t => inner.push({ RawTransaction: { ...t, Fee: '0', SigningPubKey: '', Flags: TF_INNER_BATCH } })

  if (needsAuthorize)
    leg({ TransactionType: 'MPTokenAuthorize', Account: buyer, MPTokenIssuanceID: mptId, Sequence: bSeq++ })
  leg({ TransactionType: 'Payment', Account: seller, Destination: buyer,
        Amount: { mpt_issuance_id: mptId, value: String(shares) }, Sequence: sSeq + 1 })
  leg({ TransactionType: 'Payment', Account: buyer, Destination: seller,
        Amount: amount.raw, Sequence: bSeq++ })

  if (inner.length < 2) throw new RangeError('un Batch exige au moins deux jambes (sinon temARRAY_EMPTY)')
  if (inner.length > 8) throw new RangeError(`${inner.length} jambes — le maximum est 8`)

  const batch = {
    TransactionType: 'Batch', Account: seller, Flags: flags,
    RawTransactions: inner, Sequence: sSeq,
    Fee: String(50 * (inner.length + 1)), LastLedgerSequence: li + 25,
  }
  signMultiBatch(buyerWallet, batch)                   // BatchSigners côté acheteur
  batch.SigningPubKey = sellerWallet.publicKey
  batch.TxnSignature = kpSign(encodeForSigning(batch), sellerWallet.privateKey)
  return batch
}

/**
 * EVIDENCE — le `BatchExecutions` que rippled ne fournit pas.
 *
 * La meta du Batch ne contient qu'un nœud : la ponction de frais. Les jambes
 * sont des transactions distinctes, dans le même ledger, avec leurs propres
 * hash et résultats — on les retrouve par `account_tx` sur `[idx, idx]`.
 */
export async function innerResults(client, { ledgerIndex, accounts, batchHash }) {
  const seen = new Map()
  for (const account of accounts) {
    let txs = []
    try {
      txs = (await client.request({
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

/** Soumet le Batch et attend sa validation. Ne lève pas sur un rejet du nœud. */
export async function submitBatch(client, batch, { tries = 20, wait = 2000 } = {}) {
  const sub = await client.request({ command: 'submit', tx_blob: encode(batch) })
  const hash = sub.result.tx_json?.hash
  if (sub.result.engine_result !== 'tesSUCCESS')
    return { ok: false, hash, engineResult: sub.result.engine_result, message: sub.result.engine_result_message }
  for (let i = 0; i < tries; i++) {
    await sleep(wait)
    try {
      const t = await client.request({ command: 'tx', transaction: hash })
      if (t.result.validated)
        return { ok: true, hash, engineResult: sub.result.engine_result, meta: t.result.meta,
                 ledgerIndex: t.result.ledger_index, result: t.result.meta?.TransactionResult, url: txUrl(hash) }
    } catch { /* pas encore validé */ }
  }
  return { ok: false, hash, engineResult: sub.result.engine_result, message: 'validation non observée (timeout)' }
}
