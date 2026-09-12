/**
 * probes-marche/_lib.mjs — outillage partagé des sondes marché secondaire.
 *
 * ⚠️ Fonctions candidates à l'intégration dans packages/ (LECTURE SEULE ici) :
 *    - makeCondition()        : cryptoconditions PreimageSha256 (escrow atomique)
 *    - createVaultFlags()     : VaultCreate avec flags arbitraires (non-transférable)
 *    - issueCredentialRaw()   : credential émis SANS acceptation (cas « halfway »)
 *    - fundFromTreasury()     : activation de comptes sans passer par le faucet
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { createHash, randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { BatchFlags, signMultiBatch } from 'xrpl'
import { encode, encodeForSigning } from 'ripple-binary-codec'
import { sign as kpSign } from 'ripple-keypairs'
import {
  connect, Wallet, fundAccount, submit, sequence, readVault, createdIndex,
  shareBalance, xrpBalance, sleep, rippleNow, txUrl,
} from '@secondwave/core'
import { hex } from '@secondwave/vault'

export const DIR = dirname(fileURLToPath(import.meta.url))
export const ROOT = join(DIR, '..')
export const TF_INNER = 0x40000000
export const XRP = d => (Number(d) / 1e6).toFixed(6)
export { BatchFlags, signMultiBatch, encode, encodeForSigning, kpSign, hex }

// ─────────────────────────────────────────────────────────────
// État de campagne (seeds — gitignoré via state*.json)
// ─────────────────────────────────────────────────────────────
export const statePath = name => join(DIR, `state-${name}.json`)
export const loadState = name => JSON.parse(readFileSync(statePath(name), 'utf8'))
export const saveState = (name, obj) => writeFileSync(statePath(name), JSON.stringify(obj, null, 2))
export const hasState = name => existsSync(statePath(name))

/** Recharge les wallets d'un état sauvé : { seeds: {nom: seed} } → { nom: Wallet } */
export function walletsOf(state) {
  return Object.fromEntries(Object.entries(state.seeds).map(([k, s]) => [k, Wallet.fromSeed(s)]))
}

// ─────────────────────────────────────────────────────────────
// Comptes
// ─────────────────────────────────────────────────────────────
/** Active un compte généré localement par un Payment du trésorier. Pas de faucet. */
export async function fundFromTreasury(client, treasury, drops = '25000000') {
  const w = Wallet.generate()
  const r = await submit(client, {
    TransactionType: 'Payment', Account: treasury.classicAddress,
    Destination: w.classicAddress, Amount: String(drops),
  }, treasury)
  if (!r.ok) throw new Error(`activation échouée: ${r.result}`)
  return w
}

// ─────────────────────────────────────────────────────────────
// Credentials & domaines
// ─────────────────────────────────────────────────────────────
/** Émission SANS acceptation — le bit lsfAccepted reste à zéro. */
export function issueCredentialRaw(client, issuer, subject, type = 'KYC', expiration = null) {
  return submit(client, {
    TransactionType: 'CredentialCreate', Account: issuer.classicAddress,
    Subject: subject, CredentialType: hex(type),
    ...(expiration ? { Expiration: expiration } : {}),
  }, issuer)
}

export function acceptCredential(client, subject, issuer, type = 'KYC') {
  return submit(client, {
    TransactionType: 'CredentialAccept', Account: subject.classicAddress,
    Issuer: issuer.classicAddress, CredentialType: hex(type),
  }, subject)
}

export function deleteCredential(client, issuer, subject, type = 'KYC') {
  return submit(client, {
    TransactionType: 'CredentialDelete', Account: issuer.classicAddress,
    Subject: subject, CredentialType: hex(type),
  }, issuer)
}

// ─────────────────────────────────────────────────────────────
// VaultCreate avec flags arbitraires (le helper du package force PRIVATE↔domain)
// ─────────────────────────────────────────────────────────────
export async function createVaultFlags(client, owner, {
  subscriptionIn = 120, investmentFor = 600, flags = 0, domainId = null, assetsMaximum = '0',
} = {}) {
  const subscriptionDate = rippleNow() + subscriptionIn
  const redemptionDate = subscriptionDate + investmentFor
  const r = await submit(client, {
    TransactionType: 'VaultCreate', Account: owner.classicAddress,
    Asset: { currency: 'XRP' }, AssetsMaximum: assetsMaximum, VaultKind: 1,
    SubscriptionDate: subscriptionDate, RedemptionDate: redemptionDate,
    WithdrawalPolicy: 1,
    ...(flags ? { Flags: flags } : {}),
    ...(domainId ? { DomainID: domainId } : {}),
  }, owner)
  const vaultId = createdIndex(r, 'Vault')
  const vault = vaultId ? await readVault(client, vaultId) : null
  return { ...r, vaultId, vault, mptId: vault?.ShareMPTID, subscriptionDate, redemptionDate }
}

// ─────────────────────────────────────────────────────────────
// Batch
// ─────────────────────────────────────────────────────────────
export const leg = t => ({ RawTransaction: { ...t, Fee: '0', SigningPubKey: '', Flags: TF_INNER } })

/** Enveloppe de Batch prête à signer. `legs` : transactions internes déjà séquencées. */
export async function batchEnvelope(client, account, legs, {
  flags = BatchFlags.tfAllOrNothing, seq = null, llsOffset = 25, fee = null,
} = {}) {
  const s = seq ?? await sequence(client, account)
  const li = (await client.request({ command: 'ledger', ledger_index: 'validated' })).result.ledger_index
  return {
    TransactionType: 'Batch', Account: account, Flags: flags,
    RawTransactions: legs.map(leg), Sequence: s,
    Fee: fee ?? String(50 * (legs.length + 1)), LastLedgerSequence: li + llsOffset,
  }
}

export function signEnvelope(batch, wallet) {
  batch.SigningPubKey = wallet.publicKey
  batch.TxnSignature = kpSign(encodeForSigning(batch), wallet.privateKey)
  return batch
}

/** Soumet un blob brut et attend la validation. Ne lève jamais. */
export async function sendRaw(client, tx) {
  let r
  try { r = await client.request({ command: 'submit', tx_blob: encode(tx) }) }
  catch (e) {
    return { engine: e.data?.error ?? 'error',
             message: e.data?.error_exception ?? e.data?.error_message ?? e.message }
  }
  const hash = r.result.tx_json?.hash
  if (r.result.engine_result !== 'tesSUCCESS')
    return { engine: r.result.engine_result, message: r.result.engine_result_message, hash }
  for (let i = 0; i < 20; i++) {
    await sleep(2000)
    try {
      const t = await client.request({ command: 'tx', transaction: hash })
      if (t.result.validated)
        return { engine: r.result.engine_result, validated: t.result.meta?.TransactionResult,
                 meta: t.result.meta, ledgerIndex: t.result.ledger_index, hash, url: txUrl(hash) }
    } catch { /* pas encore */ }
  }
  return { engine: r.result.engine_result, validated: 'timeout', hash }
}

/**
 * Swap standard : [authorize?] + parts vendeur→acheteur + prix acheteur→vendeur.
 * Renvoie le batch signé des deux côtés, prêt pour sendRaw.
 */
export async function swapBatch(client, {
  seller, buyer, mptId, shares, price, flags = BatchFlags.tfAllOrNothing,
  authorize = false, priceAmount = null,
}) {
  const sSeq = await sequence(client, seller.classicAddress)
  let bSeq = await sequence(client, buyer.classicAddress)
  const legs = []
  if (authorize)
    legs.push({ TransactionType: 'MPTokenAuthorize', Account: buyer.classicAddress,
                MPTokenIssuanceID: mptId, Sequence: bSeq++ })
  legs.push({ TransactionType: 'Payment', Account: seller.classicAddress,
              Destination: buyer.classicAddress,
              Amount: { mpt_issuance_id: mptId, value: String(shares) }, Sequence: sSeq + 1 })
  legs.push({ TransactionType: 'Payment', Account: buyer.classicAddress,
              Destination: seller.classicAddress,
              Amount: priceAmount ?? String(price), Sequence: bSeq++ })
  const b = await batchEnvelope(client, seller.classicAddress, legs, { flags, seq: sSeq })
  signMultiBatch(buyer, b)
  return signEnvelope(b, seller)
}

// ─────────────────────────────────────────────────────────────
// Soldes
// ─────────────────────────────────────────────────────────────
/** Photo XRP + parts d'une liste de comptes. */
export async function photo(client, mptId, accounts) {
  const out = {}
  for (const [name, addr] of Object.entries(accounts)) {
    out[name] = {
      xrp: await xrpBalance(client, addr),
      shares: mptId ? (await shareBalance(client, addr, mptId)).amount : 0n,
    }
  }
  return out
}

export function diffPhoto(before, after) {
  const out = {}
  for (const k of Object.keys(before))
    out[k] = { xrp: after[k].xrp - before[k].xrp, shares: after[k].shares - before[k].shares }
  return out
}

// ─────────────────────────────────────────────────────────────
// Cryptoconditions PreimageSha256 (pour l'escrow atomique)
// ─────────────────────────────────────────────────────────────
/** DER minimal : condition A0258020<sha256>8101<len> · fulfillment A0<l>80<l><preimage>. */
export function makeCondition(preimage = randomBytes(16)) {
  const h = createHash('sha256').update(preimage).digest()
  const lenByte = preimage.length.toString(16).padStart(2, '0')
  const condition = `A0258020${h.toString('hex')}8101${lenByte}`.toUpperCase()
  const inner = `80${lenByte}${preimage.toString('hex')}`
  const total = (inner.length / 2).toString(16).padStart(2, '0')
  const fulfillment = `A0${total}${inner}`.toUpperCase()
  return { preimage: preimage.toString('hex').toUpperCase(), condition, fulfillment }
}

// ─────────────────────────────────────────────────────────────
// Récapitulatif
// ─────────────────────────────────────────────────────────────
export function recap(resultats, titre = 'RÉCAPITULATIF') {
  console.log(`\n\n════════════════ ${titre} ════════════════\n`)
  for (const r of resultats) {
    console.log(`  [${r.cas}] ${r.question}`)
    console.log(`      R : ${r.reponse}`)
    console.log(`      → ${r.verdict}\n`)
  }
}

export {
  connect, Wallet, fundAccount, submit, sequence, readVault, createdIndex,
  shareBalance, xrpBalance, sleep, rippleNow, txUrl,
}
