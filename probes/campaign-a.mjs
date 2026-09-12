// Campagne A — VaultCreate : la matrice de validation (1-20).
import {
  startCampaign, vaultCreate, depositTx, submit, createdIndex,
  rippleNow, sleep, XRP, hex, phaseOf, VAULT_FLAGS,
} from './_lib.mjs'

const cx = await startCampaign('a')
const { O, B, S } = await cx.fundMany(['O', 'B', 'S'])   // O: créateur · B: émetteur IOU/MPT · S: empileur

const YEAR = 31_536_000

// ── 1. open-ended + 15. Fee réel
{
  const bal0 = BigInt((await cx.request({ command: 'account_info', account: O.classicAddress, ledger_index: 'validated' })).account_data.Balance)
  const oc0 = (await cx.request({ command: 'account_info', account: O.classicAddress, ledger_index: 'validated' })).account_data.OwnerCount
  const r = await vaultCreate(cx.client, O, { Asset: { currency: 'XRP' }, AssetsMaximum: '0', WithdrawalPolicy: 1 })
  cx.rec('1', 'open-ended (VaultKind absent)', 'VaultCreate minimal', r, '',
    `LEVersion=${r.vault?.LEVersion} VaultKind=${r.vault?.VaultKind ?? '(absent)'} champs=${Object.keys(r.vault ?? {}).join(',')}`)
  const bal1 = BigInt((await cx.request({ command: 'account_info', account: O.classicAddress, ledger_index: 'validated' })).account_data.Balance)
  const oc1 = (await cx.request({ command: 'account_info', account: O.classicAddress, ledger_index: 'validated' })).account_data.OwnerCount
  const fee = r.raw?.result?.tx_json?.Fee ?? '?'
  cx.note('15', `Fee autofill=${fee} drops | delta solde=${bal1 - bal0} drops | OwnerCount ${oc0}→${oc1}`)
}

// ── 2/3 : closed-ended sans l'une des deux dates
cx.rec('2', 'VaultKind:1 SANS SubscriptionDate', '', await vaultCreate(cx.client, O, {
  Asset: { currency: 'XRP' }, AssetsMaximum: '0', VaultKind: 1, RedemptionDate: rippleNow() + 600, WithdrawalPolicy: 1,
}))
cx.rec('3', 'VaultKind:1 SANS RedemptionDate', '', await vaultCreate(cx.client, O, {
  Asset: { currency: 'XRP' }, AssetsMaximum: '0', VaultKind: 1, SubscriptionDate: rippleNow() + 300, WithdrawalPolicy: 1,
}))

// ── 4 : dates dans le passé
{
  const r = await vaultCreate(cx.client, O, {
    Asset: { currency: 'XRP' }, AssetsMaximum: '0', VaultKind: 1,
    SubscriptionDate: rippleNow() - 600, RedemptionDate: rippleNow() + 300, WithdrawalPolicy: 1,
  })
  cx.rec('4', 'SubscriptionDate dans le passé', 'sub=now-600 red=now+300', r, '',
    r.vault ? `né en phase ${phaseOf(r.vault)}` : '')
}
{
  const r = await vaultCreate(cx.client, O, {
    Asset: { currency: 'XRP' }, AssetsMaximum: '0', VaultKind: 1,
    SubscriptionDate: rippleNow() - 900, RedemptionDate: rippleNow() - 300, WithdrawalPolicy: 1,
  })
  cx.rec('4b', 'les DEUX dates dans le passé', 'sub=now-900 red=now-300', r, '',
    r.vault ? `né en phase ${phaseOf(r.vault)}` : '')
}

// ── 5 : Redemption avant Subscription
cx.rec('5', 'RedemptionDate < SubscriptionDate', '', await vaultCreate(cx.client, O, {
  Asset: { currency: 'XRP' }, AssetsMaximum: '0', VaultKind: 1,
  SubscriptionDate: rippleNow() + 600, RedemptionDate: rippleNow() + 300, WithdrawalPolicy: 1,
}))

// ── 6 : le plancher de l'écart
for (const gap of [60, 120, 179, 180, 181, 300]) {
  const sub = rippleNow() + 3600
  cx.rec(`6.g${gap}`, `écart sub/red = ${gap}s`, '', await vaultCreate(cx.client, O, {
    Asset: { currency: 'XRP' }, AssetsMaximum: '0', VaultKind: 1,
    SubscriptionDate: sub, RedemptionDate: sub + gap, WithdrawalPolicy: 1,
  }))
}

// ── 7 : le plafond de l'écart
for (const [label, gap] of [['10 ans', 10 * YEAR], ['29 ans', 29 * YEAR], ['30 ans', 30 * YEAR], ['31 ans', 31 * YEAR]]) {
  const sub = rippleNow() + 300
  cx.rec(`7.${label.replace(' ', '')}`, `écart sub/red = ${label}`, `gap=${gap}s`, await vaultCreate(cx.client, O, {
    Asset: { currency: 'XRP' }, AssetsMaximum: '0', VaultKind: 1,
    SubscriptionDate: sub, RedemptionDate: sub + gap, WithdrawalPolicy: 1,
  }))
}

// ── 8 : Scale sur XRP
cx.rec('8', 'Scale:6 sur actif XRP', '', await vaultCreate(cx.client, O, {
  Asset: { currency: 'XRP' }, AssetsMaximum: '0', WithdrawalPolicy: 1, Scale: 6,
}))

// ── préparation émetteur B : IOU USD + une issuance MPT
cx.rec('prep.dr', 'AccountSet DefaultRipple sur B', '', await submit(cx.client, {
  TransactionType: 'AccountSet', Account: B.classicAddress, SetFlag: 8,
}, B))
const rMpt = await submit(cx.client, {
  TransactionType: 'MPTokenIssuanceCreate', Account: B.classicAddress, AssetScale: 2, Flags: 32,
}, B)
const MPT_B = createdIndex(rMpt, 'MPTokenIssuance')
const mptIdB = rMpt.meta?.mpt_issuance_id ?? (MPT_B ? (await cx.entry(MPT_B)).mpt_issuance_id : null)
cx.rec('prep.mpt', 'MPTokenIssuanceCreate par B', '', rMpt, '', `mpt_issuance_id=${mptIdB}`)

// ── 9 : Scale sur actif MPT (contrôle sans Scale d'abord)
if (mptIdB) {
  cx.rec('9.ctrl', 'vault sur MPT SANS Scale (contrôle)', '', await vaultCreate(cx.client, O, {
    Asset: { mpt_issuance_id: mptIdB }, AssetsMaximum: '0', WithdrawalPolicy: 1,
  }))
  cx.rec('9', 'Scale:2 sur actif MPT', '', await vaultCreate(cx.client, O, {
    Asset: { mpt_issuance_id: mptIdB }, AssetsMaximum: '0', WithdrawalPolicy: 1, Scale: 2,
  }))
}

// ── 10 : Scale sur IOU — la borne
for (const s of [0, 6, 15, 18, 19, 255]) {
  cx.rec(`10.s${s}`, `Scale:${s} sur IOU USD.B`, '', await vaultCreate(cx.client, O, {
    Asset: { currency: 'USD', issuer: B.classicAddress }, AssetsMaximum: '0', WithdrawalPolicy: 1, Scale: s,
  }))
}

// ── 12 : WithdrawalPolicy
for (const p of [1, 2, 0, 99]) {
  cx.rec(`12.p${p}`, `WithdrawalPolicy: ${p}`, '', await vaultCreate(cx.client, O, {
    Asset: { currency: 'XRP' }, AssetsMaximum: '0', WithdrawalPolicy: p,
  }))
}

// ── 13 : Data — la limite
for (const [label, bytes] of [['vide', 0], ['1 octet', 1], ['256 octets', 256], ['257 octets', 257]]) {
  cx.rec(`13.${bytes}`, `Data ${label}`, '', await vaultCreate(cx.client, O, {
    Asset: { currency: 'XRP' }, AssetsMaximum: '0', WithdrawalPolicy: 1, Data: 'AB'.repeat(bytes),
  }))
}

// ── 14 : MPTokenMetadata recopié sur l'issuance ?
{
  const meta = hex('{"name":"parts secondwave"}')
  const r = await vaultCreate(cx.client, O, {
    Asset: { currency: 'XRP' }, AssetsMaximum: '0', WithdrawalPolicy: 1, MPTokenMetadata: meta,
  })
  cx.rec('14', 'MPTokenMetadata fourni', '', r, '',
    r.vault ? `sur l'issuance: ${r.vault.shares?.MPTokenMetadata === meta ? 'RECOPIÉ' : (r.vault.shares?.MPTokenMetadata ?? '(absent)')}` : '')
}

// ── 11 : AssetsMaximum fini — comportement au dépassement
{
  const r = await vaultCreate(cx.client, O, {
    Asset: { currency: 'XRP' }, AssetsMaximum: XRP(10), WithdrawalPolicy: 1,
  })
  cx.rec('11.create', 'AssetsMaximum = 10 XRP', '', r)
  if (r.vaultId) {
    cx.rec('11.exact', 'dépôt de PILE 10 XRP', '', await submit(cx.client, depositTx(S, r.vaultId, XRP(10)), S))
    cx.rec('11.over', 'dépôt de 1 drop de plus', '', await submit(cx.client, depositTx(O, r.vaultId, '1'), O))
  }
}

// ── 16/17/18 : privé et domaine, découplés
{
  const r16 = await vaultCreate(cx.client, O, {
    Asset: { currency: 'XRP' }, AssetsMaximum: '0', WithdrawalPolicy: 1,
  }, VAULT_FLAGS.PRIVATE)
  cx.rec('16', 'tfVaultPrivate SANS DomainID', '', r16, '', r16.vault ? `shares.Flags=${r16.vault.shares?.Flags}` : '')
  if (r16.vaultId) {
    cx.rec('16.dep', 'dépôt par un tiers (S) dans un privé sans domaine', '', await submit(cx.client, depositTx(S, r16.vaultId, XRP(1)), S))
    cx.rec('16.own', 'dépôt par le PROPRIÉTAIRE dans son privé sans domaine', '', await submit(cx.client, depositTx(O, r16.vaultId, XRP(1)), O))
  }

  const rd = await submit(cx.client, {
    TransactionType: 'PermissionedDomainSet', Account: O.classicAddress,
    AcceptedCredentials: [{ Credential: { Issuer: B.classicAddress, CredentialType: hex('KYC') } }],
  }, O)
  const DID = createdIndex(rd, 'PermissionedDomain')
  cx.rec('17.dom', 'PermissionedDomainSet (décor)', '', rd)
  cx.rec('17', 'DomainID SANS tfVaultPrivate', '', await vaultCreate(cx.client, O, {
    Asset: { currency: 'XRP' }, AssetsMaximum: '0', WithdrawalPolicy: 1, DomainID: DID,
  }))
  cx.rec('18', 'tfVaultPrivate + DomainID inexistant', '', await vaultCreate(cx.client, O, {
    Asset: { currency: 'XRP' }, AssetsMaximum: '0', WithdrawalPolicy: 1,
    DomainID: 'DEAD'.repeat(16),
  }, VAULT_FLAGS.PRIVATE))
}

// ── 19 : parts non transférables — flags de l'issuance
{
  const r = await vaultCreate(cx.client, O, {
    Asset: { currency: 'XRP' }, AssetsMaximum: '0', WithdrawalPolicy: 1,
  }, VAULT_FLAGS.SHARES_NON_TRANSFERABLE)
  cx.rec('19', 'tfVaultShareNonTransferable', '', r, '', r.vault ? `shares.Flags=${r.vault.shares?.Flags}` : '')
}

// ── 20 : empilement de vaults par le même owner (S, solde faucet)
{
  const info0 = (await cx.request({ command: 'account_info', account: S.classicAddress, ledger_index: 'validated' })).account_data
  cx.note('20', `S avant: Balance=${info0.Balance} OwnerCount=${info0.OwnerCount}`)
  let n = 0, lastCode = ''
  for (let i = 0; i < 40; i++) {
    const r = await vaultCreate(cx.client, S, { Asset: { currency: 'XRP' }, AssetsMaximum: '0', WithdrawalPolicy: 1 })
    lastCode = r.result
    if (!r.ok) break
    n++
  }
  const info1 = (await cx.request({ command: 'account_info', account: S.classicAddress, ledger_index: 'validated' })).account_data
  cx.rec('20', `empilement : ${n} vaults créés avant refus`, 'VaultCreate en boucle', lastCode, '',
    `après: Balance=${info1.Balance} OwnerCount=${info1.OwnerCount}`)
}

await cx.done()
