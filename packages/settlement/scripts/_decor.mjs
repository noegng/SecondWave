/**
 * Décor commun aux scripts de chaîne — lit le monde de la démo, ne le modifie
 * jamais de façon destructive.
 *
 * ⚠️ Aucun appel au faucet : les comptes d'appoint sont activés par un Payment
 *    d'un déposant existant. Le faucet Devnet est partagé et throttle.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import {
  connect, Wallet, submit, shareBalance, xrpBalance, readVault, sleep, rippleNow,
} from '@secondwave/core'
import { issueCredential } from '@secondwave/vault'

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
export const world = JSON.parse(readFileSync(join(ROOT, 'world.json'), 'utf8'))
const seeds = JSON.parse(readFileSync(join(ROOT, 'state.json'), 'utf8'))

export const XRP = d => (Number(d) / 1e6).toFixed(6)
export const issuerWallet = () => Wallet.fromSeed(seeds.issuer)

/** Le vault `key` du monde, avec ses deux déposants (wallets) et son MPT. */
export async function scene(client, key = 'sain') {
  const v = world.vaults.find(x => x.key === key)
  if (!v) throw new Error(`vault « ${key} » absent de world.json`)
  const vault = await readVault(client, v.vaultId)
  const wallets = seeds.vaults[key].depositors.map(s => Wallet.fromSeed(s))

  const avec = []
  for (const w of wallets)
    avec.push([w, (await shareBalance(client, w.classicAddress, vault.ShareMPTID)).amount])
  avec.sort((a, b) => (b[1] > a[1] ? 1 : -1))

  return {
    key, vaultId: v.vaultId, vault, mptId: vault.ShareMPTID,
    seller: avec[0][0], sellerShares: avec[0][1],
    buyer: avec[1]?.[0] ?? null, buyerShares: avec[1]?.[1] ?? 0n,
    domainId: vault.shares?.DomainID,
  }
}

/**
 * Un membre du domaine, neuf, financé à hauteur exacte depuis `payeur`.
 * Le credential est celui du monde (type KYC, émetteur `world.issuer`).
 */
export async function nouveauMembre(client, payeur, drops = '5000000') {
  const w = Wallet.generate()
  const pay = await submit(client, {
    TransactionType: 'Payment', Account: payeur.classicAddress,
    Destination: w.classicAddress, Amount: String(drops),
  }, payeur)
  if (!pay.ok) throw new Error(`activation impossible : ${pay.result}`)
  const cred = await issueCredential(client, { issuer: issuerWallet(), subject: w })
  if (!cred.ok) throw new Error(`credential impossible : ${cred.result}`)
  return w
}

/** Ajuste le solde d'un compte à la valeur exacte voulue (à la baisse). */
export async function viderVers(client, wallet, cible, beneficiaire) {
  const bal = await xrpBalance(client, wallet.classicAddress)
  const trop = bal - BigInt(cible)
  if (trop <= 0n) return { ajuste: false, solde: bal }
  const r = await submit(client, {
    TransactionType: 'Payment', Account: wallet.classicAddress,
    Destination: beneficiaire, Amount: String(trop - 10n), Fee: '10',
  }, wallet)
  return { ajuste: r.ok, solde: await xrpBalance(client, wallet.classicAddress), result: r.result }
}

/** Journal d'état chiffré, à écrire dans probes-marche/ (gitignoré). */
export function sauverEtat(sujet, obj) {
  const p = join(ROOT, 'probes-marche', `state-${sujet}.json`)
  writeFileSync(p, JSON.stringify(obj, null, 2))
  return p
}
export function lireEtat(sujet) {
  const p = join(ROOT, 'probes-marche', `state-${sujet}.json`)
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null
}

export const titre = t => console.log(`\n━━━━━━ ${t} ━━━━━━\n`)

/** Affiche une photo de soldes lisible. */
export function montrer(label, snap, mptLabel = 'parts') {
  console.log(`  ${label}`)
  console.log(`    vendeur  ${String(snap.sellerShares).padStart(12)} ${mptLabel} · ${XRP(snap.sellerXrp)} XRP`)
  console.log(`    acheteur ${String(snap.buyerShares).padStart(12)} ${mptLabel} · ${XRP(snap.buyerXrp)} XRP`)
}

export { connect, Wallet, submit, shareBalance, xrpBalance, readVault, sleep, rippleNow }
