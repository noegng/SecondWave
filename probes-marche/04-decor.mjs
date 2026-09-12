/**
 * probes-marche/04-decor.mjs — le décor des campagnes marché secondaire.
 *
 *   node probes-marche/04-decor.mjs
 *
 * Construit un monde DÉDIÉ aux sondes de marché (ne touche pas à world.json) :
 *
 *   Domaines   domain1 (KYC) · domain2 (AML) · domain4 (KYC, mutable — cas 35)
 *   Vaults     V1  privé + domain1, transférable    ← le vault principal
 *              V2  public, transférable             ← cas 37
 *              V3  privé + domain1, NON transférable ← cas 11
 *              V4  privé + domain4 (domaine mutable) ← cas 35
 *              V5  privé + domain1, jumeau de V1     ← cas 38
 *   Comptes    issuer, owner, treasury,
 *              seller1, seller2          (membres, déposants)
 *              buyer1, buyer2            (membres, sans parts)
 *              outsider                  (aucun credential)
 *              halfway                   (credential émis, jamais accepté)
 *              expired                   (credential qui expire ~5 min après le décor)
 *              revoked                   (credential qui sera supprimé en campagne)
 *              otherdomain               (membre AML de domain2, pas de domain1)
 *              victim                    (pour AccountDelete, doit vieillir 256 ledgers)
 *   Numéraires IOU USD (issuer) · MPT « CASH » (issuer)
 *
 * Écrit tout dans probes-marche/state-marche.json (gitignoré, seeds en clair).
 * Phase Investment de V1..V5 : 6 h — largement le temps des campagnes.
 */
import {
  connect, Wallet, fundAccount, submit, readVault, sleep, rippleNow, xrpBalance,
  shareBalance, saveState, createVaultFlags, issueCredentialRaw, acceptCredential,
  fundFromTreasury, createdIndex, hex, XRP,
} from './_lib.mjs'
import { createDomain, deposit } from '@secondwave/vault'

const c = await connect()
const t0 = Date.now()
const log = m => console.log(`[${((Date.now() - t0) / 1000).toFixed(0).padStart(3)}s] ${m}`)

// ─── 1. Faucet : 6 comptes de tête ───────────────────────────
log('faucet : issuer, owner, treasury, seller1, seller2, buyer1…')
const issuer = await fundAccount()
const owner = await fundAccount()
const treasury = await fundAccount()
const seller1 = await fundAccount()
const seller2 = await fundAccount()
const buyer1 = await fundAccount()
await sleep(4000)
const grant = await xrpBalance(c, issuer.classicAddress)
log(`le faucet donne ${XRP(grant)} XRP par compte`)

/** Recharge un compte existant via le faucet (champ destination). */
async function refill(address) {
  for (let i = 0; i < 5; i++) {
    const r = await fetch('https://faucet.devnet.rippletest.net/accounts', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ destination: address }),
    })
    if (r.ok) return true
    await sleep(2000 * (i + 1))
  }
  return false
}

// seller1 doit couvrir 70 XRP de dépôts, treasury ~120 XRP d'activations.
if (grant < 90_000_000n) {
  log('recharge de seller1 et treasury…')
  await refill(seller1.classicAddress)
  await refill(treasury.classicAddress)
  await sleep(4000)
}
log(`treasury: ${XRP(await xrpBalance(c, treasury.classicAddress))} XRP · seller1: ${XRP(await xrpBalance(c, seller1.classicAddress))} XRP`)

// ─── 2. Comptes secondaires depuis le trésorier ──────────────
log('activation des comptes secondaires depuis treasury…')
const buyer2 = await fundFromTreasury(c, treasury, '35000000')
const outsider = await fundFromTreasury(c, treasury, '20000000')
const halfway = await fundFromTreasury(c, treasury, '15000000')
const expired = await fundFromTreasury(c, treasury, '15000000')
const revoked = await fundFromTreasury(c, treasury, '15000000')
const otherdomain = await fundFromTreasury(c, treasury, '15000000')
const victim = await fundFromTreasury(c, treasury, '8000000')
log('7 comptes activés')

// ─── 3. Credentials ──────────────────────────────────────────
log('credentials…')
const members = [seller1, seller2, buyer1, buyer2, revoked, victim]
for (const w of members) {
  const r = await issueCredentialRaw(c, issuer, w.classicAddress, 'KYC')
  if (!r.ok) log(`  ⚠️ CredentialCreate ${w.classicAddress}: ${r.result}`)
}
const expiration = rippleNow() + 300
await issueCredentialRaw(c, issuer, expired.classicAddress, 'KYC', expiration)
await issueCredentialRaw(c, issuer, halfway.classicAddress, 'KYC')       // jamais accepté
await issueCredentialRaw(c, issuer, otherdomain.classicAddress, 'AML')
await Promise.all([
  ...members.map(w => acceptCredential(c, w, issuer, 'KYC')),
  acceptCredential(c, expired, issuer, 'KYC'),
  acceptCredential(c, otherdomain, issuer, 'AML'),
])
log(`credentials posés (expired expire à ${expiration}, dans 300 s)`)

// ─── 4. Domaines ─────────────────────────────────────────────
const d1 = await createDomain(c, { owner, issuer, type: 'KYC' })
const d2 = await createDomain(c, { owner, issuer, type: 'AML' })
const d4 = await createDomain(c, { owner, issuer, type: 'KYC' })
log(`domaines : d1=${d1.domainId?.slice(0, 8)}… d2=${d2.domainId?.slice(0, 8)}… d4=${d4.domainId?.slice(0, 8)}…`)

// ─── 5. Vaults ───────────────────────────────────────────────
const PRIVATE = 0x00010000, NONTRANSFER = 0x00020000
const SUB_IN = 150, INVEST = 21600
log('création des 5 vaults…')
const V1 = await createVaultFlags(c, owner, { subscriptionIn: SUB_IN, investmentFor: INVEST, flags: PRIVATE, domainId: d1.domainId })
const V2 = await createVaultFlags(c, owner, { subscriptionIn: SUB_IN, investmentFor: INVEST })
const V3 = await createVaultFlags(c, owner, { subscriptionIn: SUB_IN, investmentFor: INVEST, flags: PRIVATE | NONTRANSFER, domainId: d1.domainId })
const V4 = await createVaultFlags(c, owner, { subscriptionIn: SUB_IN, investmentFor: INVEST, flags: PRIVATE, domainId: d4.domainId })
const V5 = await createVaultFlags(c, owner, { subscriptionIn: SUB_IN, investmentFor: INVEST, flags: PRIVATE, domainId: d1.domainId })
for (const [n, v] of [['V1', V1], ['V2', V2], ['V3', V3], ['V4', V4], ['V5', V5]])
  log(`  ${n} ${v.ok ? '✅' : '🔴 ' + v.result} vault=${v.vaultId?.slice(0, 10)}… mpt=${v.mptId?.slice(0, 12)}… shareFlags=${v.vault?.shares?.Flags}`)

// ─── 6. Dépôts (phase Subscription, fenêtre de 150 s) ────────
log('dépôts…')
const deps = await Promise.all([
  deposit(c, seller1, V1.vaultId, '40000000'),
  deposit(c, seller2, V1.vaultId, '30000000'),
  deposit(c, seller1, V2.vaultId, '20000000'),
  deposit(c, seller1, V3.vaultId, '10000000'),
  deposit(c, seller2, V4.vaultId, '10000000'),
  deposit(c, seller2, V5.vaultId, '10000000'),
])
deps.forEach((r, i) => { if (!r.ok) log(`  🔴 dépôt ${i}: ${r.result}`) })
log('dépôts faits')

// ─── 7. IOU USD ──────────────────────────────────────────────
log('IOU USD…')
const line = w => submit(c, {
  TransactionType: 'TrustSet', Account: w.classicAddress,
  LimitAmount: { currency: 'USD', issuer: issuer.classicAddress, value: '10000' },
}, w)
await Promise.all([line(seller1), line(buyer2)])
await submit(c, {
  TransactionType: 'Payment', Account: issuer.classicAddress,
  Destination: buyer2.classicAddress,
  Amount: { currency: 'USD', issuer: issuer.classicAddress, value: '100' },
}, issuer)

// ─── 8. MPT « CASH » ─────────────────────────────────────────
log('MPT CASH…')
const mi = await submit(c, {
  TransactionType: 'MPTokenIssuanceCreate', Account: issuer.classicAddress,
  Flags: 0x20,                                    // tfMPTCanTransfer
  MaximumAmount: '1000000000',
}, issuer)
const cashMpt = mi.meta?.AffectedNodes?.find(n => n.CreatedNode?.LedgerEntryType === 'MPTokenIssuance')
  ?.CreatedNode?.NewFields?.mpt_issuance_id
  ?? mi.raw?.result?.meta?.mpt_issuance_id ?? null
log(`  issuance CASH: ${mi.result} → ${cashMpt}`)
if (cashMpt) {
  await Promise.all([
    submit(c, { TransactionType: 'MPTokenAuthorize', Account: buyer2.classicAddress, MPTokenIssuanceID: cashMpt }, buyer2),
    submit(c, { TransactionType: 'MPTokenAuthorize', Account: seller1.classicAddress, MPTokenIssuanceID: cashMpt }, seller1),
  ])
  const pay = await submit(c, {
    TransactionType: 'Payment', Account: issuer.classicAddress,
    Destination: buyer2.classicAddress, Amount: { mpt_issuance_id: cashMpt, value: '50000000' },
  }, issuer)
  log(`  50 CASH → buyer2 : ${pay.result}`)
}

// ─── 9. Attendre la phase Investment ─────────────────────────
const wait = V1.subscriptionDate - rippleNow() + 8
if (wait > 0) { log(`attente de ${wait}s (fin de la phase Subscription)…`); await sleep(wait * 1000) }
const v1 = await readVault(c, V1.vaultId)
log(`V1 relu : AssetsTotal=${v1.AssetsTotal} Outstanding=${v1.shares?.OutstandingAmount}`)

// ─── 10. Sauvegarde ──────────────────────────────────────────
const state = {
  generatedAt: new Date().toISOString(),
  network: 'wss://s.devnet.rippletest.net:51233',
  expiredCredExpiration: expiration,
  domains: { d1: d1.domainId, d2: d2.domainId, d4: d4.domainId },
  vaults: Object.fromEntries([['V1', V1], ['V2', V2], ['V3', V3], ['V4', V4], ['V5', V5]].map(([n, v]) => [n, {
    vaultId: v.vaultId, mptId: v.mptId, pseudoAccount: v.vault?.Account,
    shareFlags: v.vault?.shares?.Flags,
    subscriptionDate: v.subscriptionDate, redemptionDate: v.redemptionDate,
  }])),
  iou: { currency: 'USD', issuer: issuer.classicAddress },
  cashMpt,
  addresses: Object.fromEntries(Object.entries({
    issuer, owner, treasury, seller1, seller2, buyer1, buyer2,
    outsider, halfway, expired, revoked, otherdomain, victim,
  }).map(([k, w]) => [k, w.classicAddress])),
  seeds: Object.fromEntries(Object.entries({
    issuer, owner, treasury, seller1, seller2, buyer1, buyer2,
    outsider, halfway, expired, revoked, otherdomain, victim,
  }).map(([k, w]) => [k, w.seed])),
}
saveState('marche', state)
log('état écrit dans probes-marche/state-marche.json')

// Photo finale
for (const [n, v] of Object.entries(state.vaults)) {
  const s1 = await shareBalance(c, seller1.classicAddress, v.mptId)
  const s2 = await shareBalance(c, seller2.classicAddress, v.mptId)
  log(`${n}: seller1=${s1.amount} seller2=${s2.amount} parts · shareFlags=${v.shareFlags}`)
}
await c.disconnect()
