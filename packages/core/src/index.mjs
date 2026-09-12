/**
 * @secondwave/core — lecture du ledger et primitives partagées.
 *
 * Contrat d'interface entre la partie vault/marché (Hugo) et l'analyste (Noé).
 *
 * ⚠️ Requiert xrpl.js@5.2.0-beta.0 : cette version embarque les champs V1_1
 *    (VaultKind, SubscriptionDate, RedemptionDate, LEVersion) dans
 *    ripple-binary-codec 2.11.0. Aucune definition custom n'est nécessaire.
 */
import { Client, Wallet } from 'xrpl'
import { encode, encodeForSigning, encodeForSigningCounterparty,
         encodeForMultisigningCounterparty } from 'ripple-binary-codec'
import { sign as kpSign } from 'ripple-keypairs'
import {
  phaseInfo, vaultMetrics, brokerMetrics, loanMetrics, concentrationHHI,
} from './analytics.mjs'

// Dérivations prêtes à l'emploi pour l'analyste (entiers en string, ratios en number).
export { phaseInfo, vaultMetrics, brokerMetrics, loanMetrics, concentrationHHI } from './analytics.mjs'

export const DEVNET_WSS = 'wss://s.devnet.rippletest.net:51233'
export const DEVNET_FAUCET = 'https://faucet.devnet.rippletest.net/accounts'
export const EXPLORER = 'https://devnet.xrpl.org'

/** Flags de l'issuance des parts */
export const SHARE_FLAGS = { REQUIRE_AUTH: 4, CAN_ESCROW: 8, CAN_TRADE: 16, CAN_TRANSFER: 32 }
/** Flags de l'objet Loan */
export const LOAN_FLAGS = { DEFAULT: 0x00010000, IMPAIRED: 0x00020000, OVERPAYMENT: 0x00040000 }
/** Flags de VaultCreate */
export const VAULT_FLAGS = { PRIVATE: 0x00010000, SHARES_NON_TRANSFERABLE: 0x00020000 }
/** Flags de LoanManage */
export const MANAGE_FLAGS = { DEFAULT: 0x00010000, IMPAIR: 0x00020000, UNIMPAIR: 0x00040000 }

const RIPPLE_EPOCH = 946684800
export const rippleNow = () => Math.floor(Date.now() / 1000) - RIPPLE_EPOCH
export const sleep = ms => new Promise(r => setTimeout(r, ms))

// ─────────────────────────────────────────────────────────────
// Connexion
// ─────────────────────────────────────────────────────────────
export async function connect(url = DEVNET_WSS) {
  const c = new Client(url)
  await c.connect()
  return c
}

/**
 * Un compte financé par le faucet Devnet. ⚠️ le seed est en clair — ne jamais committer.
 * Le faucet throttle au-delà d'une poignée de comptes : on réessaie en douceur.
 */
export async function fundAccount(tries = 5) {
  for (let i = 0; i < tries; i++) {
    const r = await fetch(DEVNET_FAUCET, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    })
    if (r.ok) return Wallet.fromSeed((await r.json()).seed)
    await sleep(2000 * (i + 1))
  }
  throw new Error('faucet injoignable après plusieurs tentatives')
}

export const txUrl = hash => `${EXPLORER}/transactions/${hash}`

/**
 * Le montant d'un Payment tel qu'il revient d'`account_tx` ou de `tx`.
 * ⚠️ L'API v2 renomme `Amount` en `DeliverMax` dans les réponses — sans le dire.
 * Tout code qui lit `tx.Amount` sur une transaction relue est silencieusement
 * aveugle. C'est vrai aussi des jambes internes d'un Batch.
 */
export const payAmount = tx => tx?.Amount ?? tx?.DeliverMax ?? null

// ─────────────────────────────────────────────────────────────
// Soumission
// ─────────────────────────────────────────────────────────────
/**
 * Une file d'attente par compte.
 *
 * `autofill` lit la séquence au moment de l'appel : deux transactions du même
 * compte lancées en parallèle reçoivent la même et la seconde meurt en
 * `tefPAST_SEQ`. Comme on veut pouvoir paralléliser librement entre comptes
 * (c'est tout l'intérêt du générateur de monde), la sérialisation est portée
 * ici plutôt que par chaque appelant.
 */
const files = new Map()
function queue(address, job) {
  const next = (files.get(address) ?? Promise.resolve()).then(job, job)
  files.set(address, next.catch(() => {}))
  return next
}

/**
 * Soumet et attend la validation. Remonte engine_result et TransactionResult
 * distinctement : un tec est "accepté et appliqué au ledger" mais a échoué.
 * ⚠️ NetworkID est omis automatiquement par le SDK (network_id 2 ≤ 1024).
 */
export function submit(client, tx, wallet) {
  return queue(wallet.classicAddress, async () => {
    let res
    try {
      res = await client.submitAndWait(tx, { wallet })
    } catch (e) {
      // submitAndWait lève sur un engine_result non-tes — on le remonte comme une valeur.
      const result = e.data?.engine_result ?? e.data?.error ?? e.message
      return { ok: false, result, message: e.data?.engine_result_message ?? e.message, error: e }
    }
    const result = res.result.meta?.TransactionResult
    const hash = res.result.hash ?? res.result.tx_json?.hash
    return { ok: result === 'tesSUCCESS', result, hash, meta: res.result.meta, url: txUrl(hash), raw: res }
  })
}

/** L'index d'un objet créé par une transaction. */
export function createdIndex(submitResult, ledgerEntryType) {
  return submitResult.meta?.AffectedNodes
    ?.find(n => n.CreatedNode?.LedgerEntryType === ledgerEntryType)
    ?.CreatedNode?.LedgerIndex ?? null
}

/**
 * ⚠️ Un code `tec` consomme la séquence sans être encore validé.
 * Toujours lire en 'current', jamais en 'validated'.
 */
export async function sequence(client, account) {
  const r = await client.request({ command: 'account_info', account, ledger_index: 'current' })
  return r.result.account_data.Sequence
}

// ─────────────────────────────────────────────────────────────
// 🔴 LoanSet — contourne le bug de co-signature du SDK
// ─────────────────────────────────────────────────────────────
/**
 * Historique : `signLoanSetByCounterparty` de xrpl.js ≤ 5.2.0-beta.0 signait avec
 * le préfixe STX\0 alors que rippled attend CPT\0 depuis fixCleanup3_4_0.
 * ✅ Corrigé dans 5.2.0-beta.1 (table SIGNING_ENCODERS par rôle) — le fix reprend
 * exactement PATCH-loanset-counterparty.md. On GARDE ce helper : il appelle les
 * mêmes encodeurs du codec, produit des octets identiques au SDK corrigé, et
 * nous isole de tout futur changement du SDK pendant l'événement.
 */
export function counterpartySign(tx, wallet, multisignAddress = null) {
  const payload = multisignAddress
    ? encodeForMultisigningCounterparty(tx, multisignAddress)   // CPM\0
    : encodeForSigningCounterparty(tx)                          // CPT\0
  return kpSign(payload, wallet.privateKey)
}

/** Construit, signe des deux côtés et soumet un LoanSet. */
export function submitLoanSet(client, terms, borrowerWallet, counterpartyWallet) {
  return queue(borrowerWallet.classicAddress, () =>
    loanSetJob(client, terms, borrowerWallet, counterpartyWallet))
}

async function loanSetJob(client, terms, borrowerWallet, counterpartyWallet) {
  const tx = await client.autofill({ ...terms, Counterparty: counterpartyWallet.classicAddress })
  tx.SigningPubKey = borrowerWallet.publicKey
  tx.TxnSignature = kpSign(encodeForSigning(tx), borrowerWallet.privateKey)
  tx.CounterpartySignature = {
    SigningPubKey: counterpartyWallet.publicKey,
    TxnSignature: counterpartySign(tx, counterpartyWallet),
  }
  const sub = await client.request({ command: 'submit', tx_blob: encode(tx) })
  if (sub.result.engine_result !== 'tesSUCCESS')
    return { ok: false, result: sub.result.engine_result, message: sub.result.engine_result_message }

  const hash = sub.result.tx_json?.hash
  for (let i = 0; i < 20; i++) {
    await sleep(2000)
    try {
      const t = await client.request({ command: 'tx', transaction: hash })
      if (t.result.validated) {
        const result = t.result.meta?.TransactionResult
        return { ok: result === 'tesSUCCESS', result, hash, meta: t.result.meta, url: txUrl(hash) }
      }
    } catch { /* pas encore dans un ledger validé */ }
  }
  return { ok: false, result: 'timeout', hash }
}

// ─────────────────────────────────────────────────────────────
// Lecture — ⚠️ il n'existe ni loan_info, ni loan_broker_info, ni mpt_holders
// ─────────────────────────────────────────────────────────────
export async function readVault(client, vaultId) {
  return (await client.request({ command: 'vault_info', vault_id: vaultId })).result.vault
}

async function objectsOfType(client, account, type) {
  try {
    const r = await client.request({ command: 'account_objects', account, type, ledger_index: 'validated' })
    return r.result.account_objects
  } catch { return [] }
}

/**
 * ⭐ L'arbre complet d'un vault, en un appel.
 * Traversée obligatoire faute de RPC : vault → pseudo-compte → brokers → pseudo-brokers → prêts.
 */
export async function readVaultGraph(client, vaultId) {
  const at = rippleNow()
  const vault = await readVault(client, vaultId)
  const brokers = await objectsOfType(client, vault.Account, 'loan_broker')
  const assetsTotal = vault.AssetsTotal ?? '0'

  const enriched = []
  for (const b of brokers) {
    const loans = await objectsOfType(client, b.Account, 'loan')
    enriched.push({
      ...b,
      metrics: brokerMetrics(b),
      loans: loans.map(l => ({
        ...l,
        metrics: loanMetrics(l, { at, brokerOwner: b.Owner, vaultAssetsTotal: assetsTotal }),
      })),
    })
  }

  // Résumé au niveau vault — ce que l'analyste lit d'abord, tout mâché.
  const vm = vaultMetrics(vault)
  const allLoans = enriched.flatMap(b => b.loans)
  const summary = {
    ...vm,
    ...phaseInfo(vault, at),
    brokerCount: enriched.length,
    loanCount: allLoans.length,
    hasUncoveredBroker: enriched.some(b => b.metrics.noCover),
    hasSelfLoan: allLoans.some(l => l.metrics.selfLoan),
    hasUndeclaredDefault: allLoans.some(l => l.metrics.defaillable),
    shareNonTransferable: Boolean(Number(vault.shares?.Flags ?? 0) & VAULT_FLAGS.SHARES_NON_TRANSFERABLE)
      || !(Number(vault.shares?.Flags ?? 0) & SHARE_FLAGS.CAN_TRANSFER),
    isIou: Boolean(vault.Asset?.currency && vault.Asset.currency !== 'XRP' && vault.Asset.issuer),
    assetIssuer: vault.Asset?.issuer ?? null,
  }

  return {
    vaultId, at: String(at),
    vault, brokers: enriched, shares: vault.shares,
    phase: phaseOf(vault),   // conservé pour compat
    metrics: summary,
  }
}

/** Subscription · Investment · Redemption — ou null si le vault est open-ended. */
export function phaseOf(vault, at = rippleNow()) {
  if (Number(vault.VaultKind ?? 0) !== 1) return null
  if (at < Number(vault.SubscriptionDate)) return 'Subscription'
  if (at < Number(vault.RedemptionDate)) return 'Investment'
  return 'Redemption'
}

/** Un objet MPToken absent = solde nul, pas une erreur. */
export async function shareBalance(client, account, mptId) {
  const objs = await objectsOfType(client, account, 'mptoken')
  const o = objs.find(x => x.MPTokenIssuanceID === mptId)
  return { holds: Boolean(o), amount: BigInt(o?.MPTAmount ?? 0), flags: Number(o?.Flags ?? 0) }
}

export async function xrpBalance(client, account) {
  try {
    const r = await client.request({ command: 'account_info', account, ledger_index: 'validated' })
    return BigInt(r.result.account_data.Balance)
  } catch { return 0n }
}

/**
 * ⭐ Répartition des parts, par rejeu de l'historique.
 * `mpt_holders` n'existe pas sur rippled — mais account_tx sur le pseudo-compte
 * du vault voit TOUT : émissions, destructions, transferts, autorisations.
 */
export async function holderMap(client, vault) {
  const mptId = vault.ShareMPTID
  const balances = new Map()

  let marker, pages = 0
  do {
    const r = await client.request({
      command: 'account_tx', account: vault.Account,
      ledger_index_min: -1, ledger_index_max: -1, limit: 200, forward: true,
      ...(marker ? { marker } : {}),
    })
    for (const t of r.result.transactions) {
      if (t.meta?.TransactionResult !== 'tesSUCCESS') continue
      // La meta suffit : peu importe que ce soit un VaultDeposit, un
      // VaultWithdraw ou un Payment, seuls les nœuds MPToken comptent.
      for (const [account, amount] of mptStates(t.meta, mptId)) balances.set(account, amount)
    }
    marker = r.result.marker; pages++
  } while (marker && pages < 20)

  const holders = [...balances.entries()].filter(([, v]) => v > 0n)
    .map(([account, shares]) => ({ account, shares }))
    .sort((a, b) => (b.shares > a.shares ? 1 : -1))
  const total = holders.reduce((s, h) => s + h.shares, 0n)
  // Le rejeu est auto-vérifiant : la somme doit retomber sur OutstandingAmount.
  const outstanding = BigInt(vault.shares?.OutstandingAmount ?? 0)
  const top = holders[0]?.shares ?? 0n
  return {
    holders, count: holders.length, total, outstanding,
    // Mirroirs sérialisables (la version BigInt reste pour la compat).
    totalStr: total.toString(), outstandingStr: outstanding.toString(),
    reconciles: total === outstanding,
    concentration: total > 0n ? Number((top * 10000n) / total) / 10000 : 0,
    hhi: concentrationHHI(holders, total),   // Herfindahl 0..10000
  }
}

/** Les soldes MPToken *après* une transaction, lus dans sa meta. */
function mptStates(meta, mptId) {
  const out = []
  for (const n of meta?.AffectedNodes ?? []) {
    const [kind, node] = Object.entries(n)[0] ?? []
    if (node?.LedgerEntryType !== 'MPToken') continue
    const f = { ...(node.NewFields ?? {}), ...(node.FinalFields ?? {}) }
    if (f.MPTokenIssuanceID !== mptId) continue
    out.push([f.Account, kind === 'DeletedNode' ? 0n : BigInt(f.MPTAmount ?? 0)])
  }
  return out
}

/** L'acheteur porte-t-il un credential accepté par le domaine du vault ? */
export async function isDomainMember(client, account, domainId) {
  if (!domainId) return { member: true, reason: 'vault public' }
  let accepted
  try {
    const r = await client.request({ command: 'ledger_entry', index: domainId, ledger_index: 'validated' })
    accepted = r.result.node.AcceptedCredentials ?? []
  } catch { return { member: false, reason: 'domaine introuvable' } }

  const creds = await objectsOfType(client, account, 'credential')
  for (const a of accepted) {
    const want = a.Credential ?? a
    const hit = creds.find(x => x.Issuer === want.Issuer
      && x.CredentialType === want.CredentialType && x.Subject === account)
    if (!hit) continue
    if (!(Number(hit.Flags ?? 0) & 0x00010000))
      return { member: false, reason: 'credential émis mais non accepté' }
    const exp = Number(hit.Expiration ?? 0)
    if (exp && exp <= rippleNow()) return { member: false, reason: 'credential expiré' }
    return { member: true, reason: 'credential valide' }
  }
  return { member: false, reason: 'aucun credential accepté par ce domaine' }
}

export { Wallet }

// ── Ré-exports de la couche analyste (Noé) fusionnés depuis main ──
export {
  TENTH_BPS,
  MANAGEMENT_FEE_RATE_MAX,
  MIN_INVESTMENT_PERIOD,
  LOAN_REDEMPTION_BUFFER,
  VaultKind,
  VaultPhase,
  LoanFlags,
  ScoreWeights,
  RatingBands,
} from './constants.mjs'

import './types.mjs'
