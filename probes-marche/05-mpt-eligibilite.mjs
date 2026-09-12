/**
 * probes-marche/05-mpt-eligibilite.mjs — Campagnes A (mécanique MPT) et D (éligibilité).
 *
 *   node probes-marche/05-mpt-eligibilite.mjs
 *
 * Cas couverts : A1–A12 · D33–D38 (le carnet, D39, est dans 10-carnet).
 * Requiert le décor de 04-decor.mjs (state-marche.json).
 */
import {
  connect, Wallet, submit, readVault, shareBalance, xrpBalance, sleep, rippleNow,
  loadState, walletsOf, recap, XRP, sendRaw, swapBatch, deleteCredential, hex,
} from './_lib.mjs'
import { isDomainMember, holderMap } from '@secondwave/core'

const S = loadState('marche')
const W = walletsOf(S)
const c = await connect()
const V1 = S.vaults.V1, V2 = S.vaults.V2, V3 = S.vaults.V3, V4 = S.vaults.V4, V5 = S.vaults.V5
const R = []
const note = (cas, question, reponse, verdict) => { R.push({ cas, question, reponse, verdict }); console.log(`  [${cas}] ${reponse}\n        → ${verdict}`) }
const code = r => `${r.result}${r.message && r.result !== 'tesSUCCESS' ? ' — ' + r.message : ''}`

const auth = (w, mptId) => submit(c, { TransactionType: 'MPTokenAuthorize', Account: w.classicAddress, MPTokenIssuanceID: mptId }, w)
const pay = (from, to, mptId, value) => submit(c, {
  TransactionType: 'Payment', Account: from.classicAddress, Destination: to.classicAddress,
  Amount: { mpt_issuance_id: mptId, value: String(value) },
}, from)

console.log('\n══ A1 · Payment simple de parts entre membres, hors Batch ══')
{
  await auth(W.buyer1, V1.mptId)
  const r = await pay(W.seller1, W.buyer1, V1.mptId, 1_000_000)
  const b = await shareBalance(c, W.buyer1.classicAddress, V1.mptId)
  note('A1', 'transfert simple membre→membre', `${code(r)} · buyer1 détient ${b.amount}`,
    r.ok ? 'confirmé — le Batch ne sert qu\'à l\'atomicité du prix' : 'surprenant')
}

console.log('\n══ A2 · Payment vers un non-membre qui s\'est AUTO-AUTORISÉ ══')
{
  const a = await auth(W.outsider, V1.mptId)
  const r = await pay(W.seller1, W.outsider, V1.mptId, 100_000)
  note('A2', 'transfert vers non-membre ayant un MPToken', `authorize ${a.result} · transfert ${code(r)}`,
    !r.ok ? 'conforme — le gate est vérifié au transfert, pas à l\'autorisation' : '🔴 TROU')
}

console.log('\n══ A3 · Credential émis mais JAMAIS accepté ══')
{
  const a = await auth(W.halfway, V1.mptId)
  const m = await isDomainMember(c, W.halfway.classicAddress, S.domains.d1)
  const r = await pay(W.seller1, W.halfway, V1.mptId, 100_000)
  note('A3', 'transfert vers credential non accepté', `member=${m.member} (${m.reason}) · transfert ${code(r)}`,
    !r.ok ? 'conforme — lsfAccepted requis' : '🔴 TROU : un credential non accepté suffit')
}

console.log('\n══ A4 · Credential EXPIRÉ ══')
{
  const now = rippleNow()
  console.log(`  expiration=${S.expiredCredExpiration} · now=${now} · ${now > S.expiredCredExpiration ? 'expiré' : `⚠️ PAS ENCORE EXPIRÉ (reste ${S.expiredCredExpiration - now}s)`}`)
  if (now <= S.expiredCredExpiration) await sleep((S.expiredCredExpiration - now + 5) * 1000)
  await auth(W.expired, V1.mptId)
  const m = await isDomainMember(c, W.expired.classicAddress, S.domains.d1)
  const r = await pay(W.seller1, W.expired, V1.mptId, 100_000)
  const b = await shareBalance(c, W.expired.classicAddress, V1.mptId)
  note('A4', 'transfert vers credential expiré', `member=${m.member} (${m.reason}) · transfert ${code(r)} · détient ${b.amount}`,
    !r.ok || b.amount === 0n ? 'conforme — l\'expiration est vérifiée on-chain' : '🔴 TROU : credential expiré accepté')
}

console.log('\n══ A5+D33+D34 · Credential SUPPRIMÉ après coup — l\'acheteur devient vendeur enfermé ? ══')
{
  await auth(W.revoked, V1.mptId)
  const r1 = await pay(W.seller1, W.revoked, V1.mptId, 500_000)   // revoked est membre : ça passe
  const d = await deleteCredential(c, W.issuer, W.revoked.classicAddress, 'KYC')
  const m = await isDomainMember(c, W.revoked.classicAddress, S.domains.d1)
  // D33 : peut-il encore RECEVOIR ?
  const r2 = await pay(W.seller1, W.revoked, V1.mptId, 100_000)
  // D34 ⭐ : peut-il encore CÉDER ses parts à un membre ?
  const r3 = await pay(W.revoked, W.seller1, V1.mptId, 200_000)
  const b = await shareBalance(c, W.revoked.classicAddress, V1.mptId)
  note('A5/D33', 'recevoir après suppression du credential',
    `achat avant: ${r1.result} · delete: ${d.result} · member=${m.member} · recevoir après: ${code(r2)}`,
    !r2.ok ? 'conforme — la suppression ferme l\'achat' : '🔴 TROU')
  note('D34', '⭐ un détenteur exclu du domaine peut-il encore VENDRE ?',
    `vente après exclusion: ${code(r3)} · solde restant ${b.amount}`,
    r3.ok ? 'OUI — la sortie reste possible, le gate ne vérifie que le destinataire'
          : '🔴 ENFERMÉ DEUX FOIS — ni VaultWithdraw (phase) ni transfert (gate) : à documenter en priorité')
}

console.log('\n══ A6 · Transfert de TOUTES ses parts — l\'objet MPToken survit-il ? ══')
{
  const before = await shareBalance(c, W.buyer1.classicAddress, V1.mptId)
  const r = await pay(W.buyer1, W.seller1, V1.mptId, before.amount)  // rend tout
  const after = await shareBalance(c, W.buyer1.classicAddress, V1.mptId)
  const hm = await holderMap(c, await readVault(c, V1.vaultId))
  const inMap = hm.holders.some(h => h.account === W.buyer1.classicAddress)
  note('A6', 'solde à zéro : objet MPToken supprimé ?',
    `transfert ${r.result} · holds=${after.holds} amount=${after.amount} · dans holderMap: ${inMap} · réconcilié: ${hm.reconciles}`,
    after.holds ? 'l\'objet MPToken reste (0,2 XRP de réserve immobilisée tant qu\'on ne fait pas Unauthorize)' : 'objet auto-supprimé')
}

console.log('\n══ A7 · Transfert de 0 part · transfert au-delà du solde ══')
{
  const r0 = await pay(W.seller1, W.buyer1, V1.mptId, 0)
  const rX = await pay(W.buyer1, W.seller1, V1.mptId, 999_999_999)   // buyer1 n'a plus rien
  note('A7', 'Payment de 0 part', code(r0), r0.ok ? 'accepté (surprenant)' : 'refusé')
  note('A7b', 'Payment au-delà du solde', code(rX), 'code à comparer à tecUNFUNDED (XRP)')
}

console.log('\n══ A8 · MPTokenAuthorize deux fois ══')
{
  const r = await auth(W.buyer1, V1.mptId)
  note('A8', 'double MPTokenAuthorize', code(r), r.ok ? 'idempotent' : 'seconde refusée — le carnet doit tolérer ce code')
}

console.log('\n══ A9 · Unauthorize en détenant encore des parts ══')
{
  await pay(W.seller1, W.buyer1, V1.mptId, 50_000)          // buyer1 re-détient
  const r = await submit(c, { TransactionType: 'MPTokenAuthorize', Account: W.buyer1.classicAddress,
    MPTokenIssuanceID: V1.mptId, Flags: 0x1 }, W.buyer1)     // tfMPTUnauthorize
  const b = await shareBalance(c, W.buyer1.classicAddress, V1.mptId)
  note('A9', 'tfMPTUnauthorize avec solde non nul', `${code(r)} · holds=${b.holds} amount=${b.amount}`,
    b.amount > 0n && !b.holds ? '🔴 parts détruites silencieusement' : r.ok ? 'surprenant : accepté' : 'refusé — cohérent')
}

console.log('\n══ A10 · TransferFee sur l\'issuance des parts ══')
{
  const v = await readVault(c, V1.vaultId)
  const e = await c.request({ command: 'ledger_entry', mpt_issuance: v.ShareMPTID, ledger_index: 'validated' })
    .catch(err => ({ error: err.data?.error ?? err.message }))
  const node = e.result?.node
  note('A10', 'l\'issuance des parts porte-t-elle un TransferFee ?',
    node ? `TransferFee=${node.TransferFee ?? 'absent'} · Flags=${node.Flags} · Issuer=${node.Issuer?.slice(0, 10)}…` : `ledger_entry: ${e.error}`,
    (node?.TransferFee ?? 0) === 0 ? 'pas de fee — un échange secondaire ne reverse rien au vault' : `fee ${node.TransferFee} — qui l'encaisse ?`)
}

console.log('\n══ A11 · Vault NON transférable : le code exact du refus ══')
{
  const a = await auth(W.buyer1, V3.mptId)
  const r = await pay(W.seller1, W.buyer1, V3.mptId, 100_000)
  const esc = await submit(c, {
    TransactionType: 'EscrowCreate', Account: W.seller1.classicAddress,
    Destination: W.buyer1.classicAddress, Amount: { mpt_issuance_id: V3.mptId, value: '100000' },
    FinishAfter: rippleNow() + 60, CancelAfter: rippleNow() + 600,
  }, W.seller1)
  note('A11', 'transfert de parts non transférables (flags=4)',
    `authorize ${a.result} · Payment ${code(r)} · EscrowCreate ${code(esc)}`,
    'le carnet doit détecter flags&32=0 en amont — codes ci-contre')
}

console.log('\n══ A12 · Détruire ses parts hors VaultWithdraw ══')
{
  const v = await readVault(c, V1.vaultId)
  const r1 = await pay(W.buyer1, { classicAddress: v.Account }, V1.mptId, 10_000)   // don au pseudo-compte
  const r2 = await submit(c, { TransactionType: 'MPTokenIssuanceDestroy', Account: W.buyer1.classicAddress,
    MPTokenIssuanceID: V1.mptId }, W.buyer1)
  const v2 = await readVault(c, V1.vaultId)
  note('A12', 'Payment de parts vers le pseudo-compte du vault',
    `${code(r1)} · Outstanding avant=${v.shares?.OutstandingAmount} après=${v2.shares?.OutstandingAmount}`,
    r1.ok ? '⚠️ le pseudo-compte accepte — quel effet comptable ?' : 'refusé')
  note('A12b', 'MPTokenIssuanceDestroy par un détenteur', code(r2), !r2.ok ? 'réservé à l\'émetteur' : '🔴')
}

console.log('\n══ D36 · Membre d\'un AUTRE domaine ══')
{
  await auth(W.otherdomain, V1.mptId)
  const m = await isDomainMember(c, W.otherdomain.classicAddress, S.domains.d1)
  const r = await pay(W.seller1, W.otherdomain, V1.mptId, 100_000)
  note('D36', 'acheteur membre d\'un autre domaine (AML pas KYC)',
    `member=${m.member} (${m.reason}) · transfert ${code(r)}`,
    !r.ok ? 'conforme — l\'appartenance est par credential, pas transitive' : '🔴 TROU')
}

console.log('\n══ D37 · Vault PUBLIC : n\'importe qui peut acheter (swap complet) ══')
{
  const before = await shareBalance(c, W.outsider.classicAddress, V2.mptId)
  const bx = await xrpBalance(c, W.outsider.classicAddress)
  const b = await swapBatch(c, { seller: W.seller1, buyer: W.outsider, mptId: V2.mptId,
    shares: 2_000_000, price: 1_800_000, authorize: true })
  const r = await sendRaw(c, b)
  await sleep(3000)
  const after = await shareBalance(c, W.outsider.classicAddress, V2.mptId)
  const ax = await xrpBalance(c, W.outsider.classicAddress)
  note('D37', 'un compte SANS credential achète dans un vault public',
    `batch ${r.engine}→${r.validated} · outsider reçoit ${after.amount - before.amount} parts · paie ${XRP(bx - ax)} XRP`,
    after.amount - before.amount === 2_000_000n ? 'conforme — le marché d\'un vault public est ouvert à tous' : 'échec — voir codes')
}

console.log('\n══ D38 · Deux vaults, même domaine : un credential ouvre les deux ══')
{
  await auth(W.buyer1, V5.mptId)
  const r1 = await pay(W.seller2, W.buyer1, V5.mptId, 100_000)     // V5, domaine d1
  const r5 = await shareBalance(c, W.buyer1.classicAddress, V5.mptId)
  const r0 = await shareBalance(c, W.buyer1.classicAddress, V1.mptId)
  note('D38', 'achat dans V1 et V5 (même domaine d1)',
    `V1: ${r0.amount} parts · V5: ${code(r1)} → ${r5.amount} parts`,
    r1.ok ? 'conforme — un credential, tout le marché du domaine' : 'surprenant')
}

console.log('\n══ D35 · Le domaine change ses AcceptedCredentials entre l\'offre et l\'exécution ══')
{
  // avant : buyer1 (KYC) est éligible sur V4 (domain4 accepte KYC)
  const m1 = await isDomainMember(c, W.buyer1.classicAddress, S.domains.d4)
  const rMut = await submit(c, {
    TransactionType: 'PermissionedDomainSet', Account: W.owner.classicAddress,
    DomainID: S.domains.d4,
    AcceptedCredentials: [{ Credential: { Issuer: W.issuer.classicAddress, CredentialType: hex('KYC2') } }],
  }, W.owner)
  const m2 = await isDomainMember(c, W.buyer1.classicAddress, S.domains.d4)
  await auth(W.buyer1, V4.mptId)
  const r = await pay(W.seller2, W.buyer1, V4.mptId, 100_000)
  note('D35', 'mutation des AcceptedCredentials du domaine',
    `avant: member=${m1.member} · mutation ${rMut.result} · après: member=${m2.member} · transfert ${code(r)}`,
    !r.ok ? 'l\'exécution suit le domaine COURANT — une offre peut mourir par mutation du domaine' : 'la mutation n\'affecte pas les transferts')
}

recap(R, 'CAMPAGNES A + D')
await c.disconnect()
