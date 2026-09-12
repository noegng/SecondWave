// Campagne H — lecture et observabilité (92-99).
// Lecture seule pour l'essentiel : s'appuie sur les vaults laissés par G2/E.
import fs from 'node:fs'
import { startCampaign, rippleNow, sleep, Wallet, XRP, depositTx } from './_lib.mjs'
import { encode, encodeForSigning } from 'ripple-binary-codec'
import { sign as kpSign } from 'ripple-keypairs'

const g2 = JSON.parse(fs.readFileSync(new URL('./state-g2.json', import.meta.url), 'utf8'))
g2.wallets = JSON.parse(fs.readFileSync(new URL('./state-g.json', import.meta.url), 'utf8')).wallets
const cx = await startCampaign('h')
const V = g2.V
const vault = (await cx.request({ command: 'vault_info', vault_id: V })).vault

// ── 92 : le recensement des commandes RPC
cx.log('=== 92. commandes RPC ===')
async function tryCmd(label, req) {
  try {
    const r = await cx.client.request(req)
    cx.rec(`92.${label}`, `commande ${req.command}${req.command === 'ledger_entry' ? ' (' + label + ')' : ''}`, JSON.stringify(req).slice(0, 90),
      'OK', '', Object.keys(r.result).slice(0, 12).join(','))
    return r.result
  } catch (e) {
    cx.rec(`92.${label}`, `commande ${req.command} (${label})`, JSON.stringify(req).slice(0, 90),
      e.data?.error ?? e.message)
    return null
  }
}
await tryCmd('vault_info', { command: 'vault_info', vault_id: V })
await tryCmd('loan_info', { command: 'loan_info', loan_id: g2.L1 })
await tryCmd('loan_broker_info', { command: 'loan_broker_info', loan_broker_id: g2.B1 })
await tryCmd('mpt_holders', { command: 'mpt_holders', mpt_issuance_id: g2.mptId })
await tryCmd('le.vault', { command: 'ledger_entry', vault: V, ledger_index: 'validated' })
await tryCmd('le.vault2', { command: 'ledger_entry', index: V, ledger_index: 'validated' })
await tryCmd('le.loan', { command: 'ledger_entry', index: g2.L1, ledger_index: 'validated' })
await tryCmd('le.loan_t', { command: 'ledger_entry', loan: g2.L1, ledger_index: 'validated' })
await tryCmd('le.broker_t', { command: 'ledger_entry', loan_broker: g2.B1, ledger_index: 'validated' })
await tryCmd('le.mptI', { command: 'ledger_entry', mpt_issuance: g2.mptId, ledger_index: 'validated' })

// ── 93 : vault_info vs objet brut
{
  const raw = (await cx.client.request({ command: 'ledger_entry', index: V, ledger_index: 'validated' })).result.node
  const viKeys = Object.keys(vault).sort()
  const rawKeys = Object.keys(raw).sort()
  const onlyVi = viKeys.filter(k => !rawKeys.includes(k))
  const onlyRaw = rawKeys.filter(k => !viKeys.includes(k))
  cx.rec('93', 'vault_info vs ledger_entry brut', '',
    `vault_info en plus: [${onlyVi.join(',')}] · brut en plus: [${onlyRaw.join(',')}]`, '',
    `vault_info: ${viKeys.join(',')}`)
}

// ── 94 : types d'objets sur le pseudo-compte
{
  const objs = (await cx.request({ command: 'account_objects', account: vault.Account, ledger_index: 'validated' })).account_objects
  const types = {}
  for (const o of objs) types[o.LedgerEntryType] = (types[o.LedgerEntryType] ?? 0) + 1
  cx.rec('94', 'account_objects du pseudo-compte vault', '', JSON.stringify(types))
  const ai = await cx.request({ command: 'account_info', account: vault.Account, ledger_index: 'validated' })
  cx.note('94', `pseudo-compte: Balance=${ai.account_data.Balance} Flags=${ai.account_data.Flags} RegularKey=${ai.account_data.RegularKey ?? '(aucune)'} OwnerCount=${ai.account_data.OwnerCount}`)
}

// ── 95 : que voit account_tx du pseudo-compte ?
{
  const txs = await cx.request({ command: 'account_tx', account: vault.Account, ledger_index_min: -1, ledger_index_max: -1, limit: 200 })
  const types = {}
  for (const t of txs.transactions) {
    const ty = (t.tx_json ?? t.tx)?.TransactionType ?? '?'
    types[ty] = (types[ty] ?? 0) + 1
  }
  cx.rec('95', 'account_tx du pseudo-compte (types vus)', '', JSON.stringify(types), '',
    'LoanManage et LoanSet visibles = défauts et prêts journalisés')
}

// ── 96 + 97 : subscribe temps réel, et simulate
{
  const events = []
  await cx.client.request({ command: 'subscribe', accounts: [vault.Account] })
  cx.client.on('transaction', t => events.push(t.tx_json?.TransactionType ?? t.transaction?.TransactionType ?? '?'))

  // 97 : simulate — sur les tx XLS-65/66
  const O = Wallet.fromSeed(g2.wallets.O.seed)
  const D = Wallet.fromSeed(g2.wallets.D.seed)
  async function trySim(label, tx) {
    try {
      const r = await cx.client.request({ command: 'simulate', tx_json: tx })
      cx.rec(`97.${label}`, `simulate ${tx.TransactionType}`, '', r.result.engine_result ?? JSON.stringify(r.result).slice(0, 60),
        '', `applied=${r.result.applied ?? '?'}`)
    } catch (e) {
      cx.rec(`97.${label}`, `simulate ${tx.TransactionType}`, '', e.data?.error ?? e.message)
    }
  }
  await trySim('vc', { TransactionType: 'VaultCreate', Account: O.classicAddress, Asset: { currency: 'XRP' }, AssetsMaximum: '0', WithdrawalPolicy: 1 })
  await trySim('dep', { TransactionType: 'VaultDeposit', Account: D.classicAddress, VaultID: V, Amount: XRP(1) })
  await trySim('lm', { TransactionType: 'LoanManage', Account: O.classicAddress, LoanID: g2.L1, Flags: 0x00020000 })
  await trySim('lpay', { TransactionType: 'LoanPay', Account: D.classicAddress, LoanID: g2.L1, Amount: XRP(1) })
  // LoanSet en simulate : sans signatures du tout
  await trySim('lset', {
    TransactionType: 'LoanSet', Account: D.classicAddress, LoanBrokerID: g2.B1,
    Counterparty: O.classicAddress, PrincipalRequested: XRP(1), PaymentInterval: 120, PaymentTotal: 1, GracePeriod: 60, InterestRate: 0,
  })

  // 96 : provoquer un événement réel — un dépôt (le vault g2 est-il encore en Subscription ? peu importe le code)
  const { submit } = await import('@secondwave/core')
  await submit(cx.client, depositTx(D, V, XRP(1)), D)
  await sleep(6000)
  cx.rec('96', 'subscribe sur le pseudo-compte', 'dépôt émis pendant l\'abonnement',
    events.length ? `reçu en temps réel: [${events.join(',')}]` : 'AUCUN événement reçu',
    events.length ? 'attendu' : 'surprenant')
  await cx.client.request({ command: 'unsubscribe', accounts: [vault.Account] })
}

// ── 98 : server_definitions vs ripple-binary-codec 2.11.0
{
  const sd = (await cx.client.request({ command: 'server_definitions' })).result
  const { default: defsPkg } = await import('ripple-binary-codec/dist/enums/definitions.json', { with: { type: 'json' } })
  const serverFields = new Set(sd.FIELDS.map(f => f[0]))
  const localFields = new Set(defsPkg.FIELDS.map(f => f[0]))
  const onlyServer = [...serverFields].filter(f => !localFields.has(f))
  const onlyLocal = [...localFields].filter(f => !serverFields.has(f))
  const serverTT = Object.keys(sd.TRANSACTION_TYPES)
  const localTT = Object.keys(defsPkg.TRANSACTION_TYPES)
  const ttOnlyServer = serverTT.filter(t => !localTT.includes(t))
  cx.rec('98', 'diff server_definitions vs codec local', '',
    `champs serveur absents du codec: ${onlyServer.length} · champs codec absents du serveur: ${onlyLocal.length} · tx types serveur en plus: ${ttOnlyServer.length}`,
    onlyServer.length ? 'non documenté' : 'attendu',
    `serveur only: [${onlyServer.join(',')}] · codec only: [${onlyLocal.join(',')}] · ttServeur: [${ttOnlyServer.join(',')}]`)
}

// ── 99 : le coût en RPC d'une reconstruction complète
{
  let calls = 0
  const req = async r => { calls++; return (await cx.client.request(r)).result }
  const v = (await req({ command: 'vault_info', vault_id: V })).vault
  const brokers = (await req({ command: 'account_objects', account: v.Account, type: 'loan_broker', ledger_index: 'validated' })).account_objects
  let loans = 0
  for (const b of brokers) {
    const ls = (await req({ command: 'account_objects', account: b.Account, type: 'loan', ledger_index: 'validated' })).account_objects
    loans += ls.length
  }
  // holders : account_tx paginé
  let marker, pages = 0
  do {
    const r = await req({ command: 'account_tx', account: v.Account, ledger_index_min: -1, ledger_index_max: -1, limit: 200, ...(marker ? { marker } : {}) })
    marker = r.marker; pages++
  } while (marker && pages < 20)
  cx.rec('99', `reconstruction complète: ${calls} appels RPC`, `${brokers.length} brokers, ${loans} prêts, ${pages} pages account_tx`,
    `${calls} appels`, '', 'formule: 2 + nb_brokers + pages_account_tx — aucun appel direct par prêt possible')
}

await cx.done()
