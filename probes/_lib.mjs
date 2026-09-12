/**
 * probes/_lib.mjs — harnais commun des campagnes de sonde XLS-65/66.
 *
 * Chaque campagne : `const cx = await startCampaign('a')`, puis
 * `cx.rec(id, titre, envoyé, résultat, verdict, note)` pour chaque cas,
 * et `await cx.done()` qui imprime le tableau récapitulatif et écrit
 * probes/out/<campagne>.json.
 *
 * ⚠️ les seeds générés sont écrits dans probes/state-<campagne>.json
 *    (gitignoré par la règle state*.json) — jamais dans les logs.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  connect, fundAccount, submit, submitLoanSet, createdIndex, sequence,
  readVault, readVaultGraph, phaseOf, shareBalance, xrpBalance, holderMap,
  rippleNow, sleep, txUrl, counterpartySign,
  SHARE_FLAGS, LOAN_FLAGS, VAULT_FLAGS, MANAGE_FLAGS, Wallet,
} from '@secondwave/core'
import { encode, encodeForSigning } from 'ripple-binary-codec'
import { sign as kpSign } from 'ripple-keypairs'

export {
  submit, submitLoanSet, createdIndex, sequence, readVault, readVaultGraph,
  phaseOf, shareBalance, xrpBalance, holderMap, rippleNow, sleep, txUrl,
  counterpartySign, SHARE_FLAGS, LOAN_FLAGS, VAULT_FLAGS, MANAGE_FLAGS, Wallet,
}

const DIR = path.dirname(fileURLToPath(import.meta.url))
const OUT = path.join(DIR, 'out')
fs.mkdirSync(OUT, { recursive: true })

export const hex = s => Buffer.from(s, 'utf8').toString('hex').toUpperCase()
export const XRP = n => String(Math.round(n * 1_000_000))         // XRP -> drops

/** Résumé court d'un résultat de submit() de core. */
export const code = r => r?.result ?? r?.engine_result ?? '???'

export async function startCampaign(name) {
  const t0 = Date.now()
  const client = await connect()
  const rows = []
  const state = { name, started: new Date().toISOString(), wallets: {} }
  const statePath = path.join(DIR, `state-${name}.json`)

  const log = (...a) => console.log(...a)

  /** Enregistre un cas. `sent` = description compacte de la tx, `res` = résultat submit ou texte. */
  function rec(id, title, sent, res, verdict = '', note = '') {
    const c = typeof res === 'string' ? res : code(res)
    const msg = typeof res === 'object' ? (res?.message ?? '') : ''
    const url = typeof res === 'object' && res?.hash ? txUrl(res.hash) : ''
    rows.push({ id, title, sent, code: c, message: msg, verdict, note, url })
    log(`  [${id}] ${title} → ${c}${verdict ? `  (${verdict})` : ''}${note ? ` — ${note}` : ''}`)
    return res
  }

  /** Note libre (contexte, mesure) rattachée au rapport. */
  function note(id, text) {
    rows.push({ id, title: '(mesure)', sent: '', code: '', message: '', verdict: '', note: text, url: '' })
    log(`  [${id}] ${text}`)
  }

  /** n wallets financés séquentiellement (le faucet throttle), seeds sauvés.
   *  Reprise : si le state existant contient déjà ces wallets, on les réutilise. */
  async function fundMany(names) {
    try {
      const prev = JSON.parse(fs.readFileSync(statePath, 'utf8'))
      if (prev?.wallets && names.every(n => prev.wallets[n])) {
        const out = {}
        for (const n of names) { out[n] = Wallet.fromSeed(prev.wallets[n].seed); state.wallets[n] = prev.wallets[n] }
        log('  wallets repris du state existant')
        return out
      }
    } catch { /* pas de state : on finance */ }
    const out = {}
    for (const n of names) {
      out[n] = await fundAccount()
      state.wallets[n] = { address: out[n].classicAddress, seed: out[n].seed }
      fs.writeFileSync(statePath, JSON.stringify(state, null, 2))
      log(`  financé ${n}: ${out[n].classicAddress}`)
      await sleep(1500)
    }
    // laisse le faucet/ledger se poser
    await sleep(4000)
    return out
  }

  function saveState(extra) {
    Object.assign(state, extra)
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2))
  }

  const request = req => client.request(req).then(r => r.result)

  async function entry(index) {
    return (await client.request({ command: 'ledger_entry', index, ledger_index: 'validated' })).result.node
  }

  /** Signe et soumet SANS attendre la validation. Renvoie {engine, message, hash}. */
  async function fire(tx, wallet, { seq = null, lls = 40 } = {}) {
    const p = { ...tx }
    if (p.Fee == null) p.Fee = '15'
    if (p.Sequence == null) p.Sequence = seq ?? await sequence(client, wallet.classicAddress)
    if (p.LastLedgerSequence == null) {
      const li = (await client.request({ command: 'ledger', ledger_index: 'validated' })).result.ledger_index
      p.LastLedgerSequence = li + lls
    }
    p.SigningPubKey = wallet.publicKey
    p.TxnSignature = kpSign(encodeForSigning(p), wallet.privateKey)
    const r = await client.request({ command: 'submit', tx_blob: encode(p) })
    return { engine: r.result.engine_result, message: r.result.engine_result_message, hash: r.result.tx_json?.hash, tx: p }
  }

  /** Attend le sort final d'un hash (code validé, ledger, close_time). */
  async function finalOf(hash, tries = 25) {
    for (let i = 0; i < tries; i++) {
      await sleep(2000)
      try {
        const t = await client.request({ command: 'tx', transaction: hash })
        if (t.result.validated) {
          const lgr = t.result.ledger_index
          let close = null
          try {
            const l = await client.request({ command: 'ledger', ledger_index: lgr })
            close = l.result.ledger.close_time
          } catch { /* tant pis */ }
          return { result: t.result.meta?.TransactionResult, ledger: lgr, close, hash }
        }
      } catch { /* pas encore */ }
    }
    return { result: 'jamais validé', hash }
  }

  /**
   * Rafale : N transactions du même compte, séquences explicites, soumises
   * d'un coup puis attendues. Pour les tests d'arrondi en volume.
   */
  async function burst(txs, wallet) {
    const seq0 = await sequence(client, wallet.classicAddress)
    const li = (await client.request({ command: 'ledger', ledger_index: 'validated' })).result.ledger_index
    const fired = []
    for (let i = 0; i < txs.length; i++) {
      const p = { ...txs[i], Fee: '15', Sequence: seq0 + i, LastLedgerSequence: li + 60 }
      p.SigningPubKey = wallet.publicKey
      p.TxnSignature = kpSign(encodeForSigning(p), wallet.privateKey)
      const r = await client.request({ command: 'submit', tx_blob: encode(p) })
      fired.push({ engine: r.result.engine_result, hash: r.result.tx_json?.hash })
    }
    // on n'attend que la dernière : les séquences imposent l'ordre
    const last = fired[fired.length - 1]
    const fin = await finalOf(last.hash, 40)
    return { fired, lastFinal: fin }
  }

  /** Fin de campagne : tableau + JSON. */
  async function done() {
    const secs = Math.round((Date.now() - t0) / 1000)
    log(`\n===== RÉCAP campagne ${name.toUpperCase()} (${secs}s) =====`)
    log('id'.padEnd(6) + 'code'.padEnd(26) + 'verdict'.padEnd(16) + 'cas')
    for (const r of rows) {
      if (r.title === '(mesure)') { log(`${r.id.padEnd(6)}${'—'.padEnd(26)}${''.padEnd(16)}${r.note}`); continue }
      log(`${String(r.id).padEnd(6)}${String(r.code).padEnd(26)}${String(r.verdict).padEnd(16)}${r.title}`)
    }
    fs.writeFileSync(path.join(OUT, `${name}.json`), JSON.stringify({ name, secs, rows }, null, 2))
    log(`\n→ probes/out/${name}.json`)
    await client.disconnect()
  }

  return { client, rec, note, fundMany, saveState, request, entry, fire, finalOf, burst, done, log, statePath }
}

/**
 * submitLoanSet de core laisse remonter les erreurs "fails local checks" du
 * nœud comme exceptions WebSocket (elles ne passent jamais l'engine) — on les
 * rabat ici en valeur, comme le reste.
 */
export async function safeLoanSet(client, terms, borrower, counterparty) {
  try { return await submitLoanSet(client, terms, borrower, counterparty) }
  catch (e) {
    return { ok: false, result: e.data?.error ?? 'exception', message: e.data?.error_exception ?? e.message }
  }
}

/** Crée un vault et renvoie {vaultId, vault, mptId, ...res}. Champs bruts, aucune aide. */
export async function vaultCreate(client, owner, fields, flags = null) {
  const tx = { TransactionType: 'VaultCreate', Account: owner.classicAddress, ...fields }
  if (flags != null) tx.Flags = flags
  const r = await submit(client, tx, owner)
  const vaultId = createdIndex(r, 'Vault')
  let vault = null
  try { vault = vaultId ? await readVault(client, vaultId) : null } catch { /* tant pis */ }
  return { ...r, vaultId, vault, mptId: vault?.ShareMPTID }
}

export const depositTx = (who, vaultId, amount) => ({
  TransactionType: 'VaultDeposit', Account: who.classicAddress, VaultID: vaultId, Amount: amount,
})
export const withdrawTx = (who, vaultId, mptId, shares) => ({
  TransactionType: 'VaultWithdraw', Account: who.classicAddress, VaultID: vaultId,
  Amount: { mpt_issuance_id: mptId, value: String(shares) },
})
