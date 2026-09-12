// Campagne D — vault privé, domaine, credentials (39-49).
import {
  startCampaign, vaultCreate, depositTx, withdrawTx,
  submit, createdIndex, rippleNow, sleep, XRP, hex, shareBalance, VAULT_FLAGS,
} from './_lib.mjs'

const cx = await startCampaign('d')
const { I, O, alice, carol, dave, erin } = await cx.fundMany(['I', 'O', 'alice', 'carol', 'dave', 'erin'])

const KYC = hex('KYC'), KYB = hex('KYB')
const expiry = rippleNow() + 170

// ── credentials
for (const [w, n, opts] of [
  [alice, 'alice', {}],
  [dave, 'dave', { skipAccept: true }],
  [erin, 'erin', { expiration: expiry }],
]) {
  const c1 = await submit(cx.client, {
    TransactionType: 'CredentialCreate', Account: I.classicAddress, Subject: w.classicAddress,
    CredentialType: KYC, ...(opts.expiration ? { Expiration: opts.expiration } : {}),
  }, I)
  cx.rec(`D0.${n}`, `CredentialCreate → ${n}${opts.expiration ? ' (expire dans 170s)' : ''}${opts.skipAccept ? ' (jamais accepté)' : ''}`, '', c1)
  if (!opts.skipAccept) {
    await submit(cx.client, {
      TransactionType: 'CredentialAccept', Account: w.classicAddress, Issuer: I.classicAddress, CredentialType: KYC,
    }, w)
  }
}

// ── domaine
const rd = await submit(cx.client, {
  TransactionType: 'PermissionedDomainSet', Account: O.classicAddress,
  AcceptedCredentials: [{ Credential: { Issuer: I.classicAddress, CredentialType: KYC } }],
}, O)
const DID = createdIndex(rd, 'PermissionedDomain')
cx.rec('D0.dom', 'PermissionedDomainSet (KYC par I)', '', rd)

// ── 48 : le propriétaire (SANS credential) peut-il créer et utiliser son vault privé ?
const sub = rippleNow() + 340
const red = sub + 200
const V = await vaultCreate(cx.client, O, {
  Asset: { currency: 'XRP' }, AssetsMaximum: '0', VaultKind: 1,
  SubscriptionDate: sub, RedemptionDate: red, WithdrawalPolicy: 1, DomainID: DID,
}, VAULT_FLAGS.PRIVATE)
cx.rec('48.create', 'VaultCreate privé+domaine par O (O sans credential)', '', V)
cx.rec('48.dep', 'dépôt par O (propriétaire NON membre du domaine)', '', await submit(cx.client, depositTx(O, V.vaultId, XRP(2)), O))
cx.saveState({ V: V.vaultId, mptId: V.mptId, DID })

// ── 43 : DomainID recopié sur l'issuance ?
cx.rec('43', 'DomainID sur l\'issuance des parts', 'vault_info.shares',
  `vault.DomainID=${V.vault?.DomainID?.slice(0, 8)}… | shares.DomainID=${V.vault?.shares?.DomainID ? V.vault.shares.DomainID.slice(0, 8) + '…' : '(ABSENT)'} | shares.Flags=${V.vault?.shares?.Flags}`)

// ── 39/40/41a/42a
cx.rec('39', 'dépôt par carol (aucun credential)', '', await submit(cx.client, depositTx(carol, V.vaultId, XRP(5)), carol))
cx.rec('40', 'dépôt par dave (credential émis mais JAMAIS accepté)', '', await submit(cx.client, depositTx(dave, V.vaultId, XRP(5)), dave))
cx.rec('41a', 'dépôt par erin (credential valide, expire bientôt)', '', await submit(cx.client, depositTx(erin, V.vaultId, XRP(5)), erin))
cx.rec('42a', 'dépôt par alice (credential valide)', '', await submit(cx.client, depositTx(alice, V.vaultId, XRP(10)), alice))

// ── 44 : le domaine change APRÈS coup — effet immédiat ?
cx.rec('44.set', 'PermissionedDomainSet: AcceptedCredentials ← [KYB] (KYC éjecté)', '', await submit(cx.client, {
  TransactionType: 'PermissionedDomainSet', Account: O.classicAddress, DomainID: DID,
  AcceptedCredentials: [{ Credential: { Issuer: I.classicAddress, CredentialType: KYB } }],
}, O))
cx.rec('44.dep', 'alice (KYC) dépose après l\'éviction de KYC', '', await submit(cx.client, depositTx(alice, V.vaultId, XRP(1)), alice))
cx.rec('44.wd', 'alice (KYC) RETIRE après l\'éviction — enfermée ?', '', await submit(cx.client, withdrawTx(alice, V.vaultId, V.mptId, 1_000_000), alice))

// ── 45 : deux credentials acceptés, un seul suffit ?
cx.rec('45.set', 'AcceptedCredentials ← [KYC, KYB]', '', await submit(cx.client, {
  TransactionType: 'PermissionedDomainSet', Account: O.classicAddress, DomainID: DID,
  AcceptedCredentials: [
    { Credential: { Issuer: I.classicAddress, CredentialType: KYC } },
    { Credential: { Issuer: I.classicAddress, CredentialType: KYB } },
  ],
}, O))
cx.rec('45', 'alice (KYC seulement) dépose — un seul credential suffit ?', '', await submit(cx.client, depositTx(alice, V.vaultId, XRP(1)), alice))

// ── 46 : combien de credentials max ?
{
  const mk = n => Array.from({ length: n }, (_, i) => ({ Credential: { Issuer: I.classicAddress, CredentialType: hex('T' + i) } }))
  const r10 = await submit(cx.client, {
    TransactionType: 'PermissionedDomainSet', Account: O.classicAddress, AcceptedCredentials: mk(10),
  }, O)
  cx.rec('46.10', 'domaine avec 10 AcceptedCredentials', '', r10)
  const r11 = await submit(cx.client, {
    TransactionType: 'PermissionedDomainSet', Account: O.classicAddress, AcceptedCredentials: mk(11),
  }, O)
  cx.rec('46.11', 'domaine avec 11 AcceptedCredentials', '', r11)
}

// ── 47 : credential d'un "émetteur" qui n'a jamais rien émis
cx.rec('47', 'domaine acceptant un credential de carol (jamais émis)', '', await submit(cx.client, {
  TransactionType: 'PermissionedDomainSet', Account: O.classicAddress,
  AcceptedCredentials: [{ Credential: { Issuer: carol.classicAddress, CredentialType: hex('GHOST') } }],
}, O))

// ── 49 : la grille des flags d'issuance
{
  const r1 = await vaultCreate(cx.client, O, {
    Asset: { currency: 'XRP' }, AssetsMaximum: '0', WithdrawalPolicy: 1,
    VaultKind: 1, SubscriptionDate: rippleNow() + 300, RedemptionDate: rippleNow() + 500, DomainID: DID,
  }, VAULT_FLAGS.PRIVATE | VAULT_FLAGS.SHARES_NON_TRANSFERABLE)
  cx.rec('49.pn', 'privé + non-transférable', '', r1, '', r1.vault ? `shares.Flags=${r1.vault.shares?.Flags} DomainID=${r1.vault.shares?.DomainID ? 'présent' : 'absent'}` : '')
}
cx.note('49', 'rappel: public transférable=56 (A1) · privé transférable=60 (A16/D) · public non-transférable=0 (A19)')

// ── 41b : expiration d'erin (attendre expiry)
{
  const wait = expiry - rippleNow() + 8
  if (wait > 0) { cx.log(`attente expiration du credential d'erin (${wait}s)…`); await sleep(wait * 1000) }
}
cx.rec('41b.dep', 'erin dépose APRÈS expiration du credential', '', await submit(cx.client, depositTx(erin, V.vaultId, XRP(1)), erin))
cx.rec('41b.wd', 'erin retire APRÈS expiration — enfermée ?', '', await submit(cx.client, withdrawTx(erin, V.vaultId, V.mptId, 1_000_000), erin))
{
  const sb = await shareBalance(cx.client, erin.classicAddress, V.mptId)
  cx.note('41b', `parts d'erin restantes: ${sb.amount}`)
}

// ── 42b : révocation du credential d'alice
cx.rec('42b.del', 'CredentialDelete alice par l\'émetteur', '', await submit(cx.client, {
  TransactionType: 'CredentialDelete', Account: I.classicAddress, Subject: alice.classicAddress, CredentialType: KYC,
}, I))
cx.rec('42b.dep', 'alice dépose après révocation', '', await submit(cx.client, depositTx(alice, V.vaultId, XRP(1)), alice))
cx.rec('42b.wd', 'alice retire après révocation — enfermée ?', '', await submit(cx.client, withdrawTx(alice, V.vaultId, V.mptId, 1_000_000), alice))
{
  const sb = await shareBalance(cx.client, alice.classicAddress, V.mptId)
  cx.note('42b', `parts d'alice restantes: ${sb.amount}`)
}

await cx.done()
