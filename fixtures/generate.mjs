/**
 * fixtures/generate.mjs — le générateur de monde v2.
 *
 *   npm run world
 *
 * Construit sur le Devnet public une famille de vaults privés closed-ended dont
 * chacun incarne un cas que l'analyste doit savoir distinguer — y compris ceux
 * que seule la campagne de sonde a révélés (auto-prêt, cover 0/0, défaillable
 * non déclaré, clawback armé, parts non transférables, phase Redemption).
 *
 * Trois sorties :
 *   · world.json    — identifiants publics.                        [committé]
 *   · state.json    — comptes ET SEEDS. ⚠️ gitignoré, jamais publié.
 *   · snapshot.json — le dump complet readVaultGraph + holderMap de chaque
 *                     vault, entiers en string. C'EST le livrable de l'analyste :
 *                     il travaille dessus HORS LIGNE, sans Devnet ni faucet.  [committé]
 *
 * ⚠️ LE MONDE VIEILLIT. Les échéances de prêt tombent toutes les ~120 s ; les
 *    prêts « défaillables » et « en grâce » changent d'état en quelques minutes.
 *    snapshot.json fige un instant — mais pour une démo live, RÉGÉNÉRER le monde
 *    peu avant (npm run world), puis re-snapshoter.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import {
  connect, fundAccount, readVaultGraph, holderMap, submit, sleep, rippleNow, txUrl,
} from '@secondwave/core'
import {
  issueCredential, createCredential, createDomain, createVault, deposit, createBroker,
  coverDeposit, createLoan, payLoan, impair, unimpair, deleteLoan,
} from '@secondwave/vault'

const HERE = dirname(fileURLToPath(import.meta.url))
const XRP = n => String(Math.round(n * 1_000_000))
const log = (...a) => console.log(...a)
const jsonBig = (o) => JSON.stringify(o, (_, v) => (typeof v === 'bigint' ? v.toString() : v), 2)

const LSF_ALLOW_CLAWBACK = 0x80000000

/** Fenêtres par défaut, compressées à l'échelle d'un hackathon. */
const ADDR_RE = /^r[1-9A-HJ-NP-Za-km-z]{24,34}$/
/**
 * Invités : des wallets réels (extension) qu'on crédentialise pour qu'ils
 * déposent pendant la Subscription et apparaissent comme détenteurs.
 *   npm run world -- --invite rHugo --invite rNoe
 *   npm run world -- --invite rHugo,rNoe
 *   INVITE=rHugo,rNoe npm run world
 * ⚠️ Ils ne pourront pas ÊTRE PARTIE au swap : le Batch exige les deux clés
 *    privées (settlement/batch.mjs:56), et l'extension ne signe pas de Batch.
 */
function parseInvites() {
  const argv = process.argv.slice(2)
  const out = []
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--invite') out.push(...(argv[++i] ?? '').split(','))
    else if (argv[i].startsWith('--invite=')) out.push(...argv[i].slice('--invite='.length).split(','))
    else if (ADDR_RE.test(argv[i])) out.push(argv[i])
  }
  if (!out.length && process.env.INVITE) out.push(...process.env.INVITE.split(','))
  return [...new Set(out.map((a) => a.trim()).filter(Boolean))]
}
const INVITES = parseInvites()
for (const a of INVITES) {
  if (!ADDR_RE.test(a)) throw new Error(`adresse invite invalide : ${a}`)
}

const SUBSCRIPTION_IN = INVITES.length ? 480 : 130
const INVESTMENT_FOR = 900

// ─────────────────────────────────────────────────────────────
// Les profils. Chacun est un cas de test pour l'analyste.
// asset: 'XRP' | 'IOU' · borrower: 'external' | 'owner' (auto-prêt)
// action: pay(n) | leave | impair | unimpair(=impair puis lève) | settle
// ─────────────────────────────────────────────────────────────
const PROFILS = [
  {
    key: 'sain',
    label: 'Vault sain — garantie normale, un prêt qui paie, un prêt qu\'on laisse filer',
    asset: 'XRP', depots: [25, 20], borrowers: 2,
    brokers: [{ coverRateMinimum: 10000, coverRateLiquidation: 50000, cover: 6, debtMaximum: XRP(40) }],
    loans: [
      { broker: 0, principal: 8, borrower: 'external', action: { pay: 5 } },
      { broker: 0, principal: 6, borrower: 'external', action: { leave: true } },   // → défaillable non déclaré
    ],
  },
  {
    key: 'predateur',
    label: 'Vault prédateur — broker 0/0 (aucun first-loss) + AUTO-PRÊT du propriétaire, jamais remboursé',
    asset: 'XRP', depots: [30, 20], borrowers: 0,
    brokers: [{ coverRateMinimum: 0, coverRateLiquidation: 0, cover: 0, debtMaximum: XRP(45) }],
    loans: [
      { broker: 0, principal: 22, borrower: 'owner', action: { leave: true } },     // 🔴 la recette du rug-pull
    ],
  },
  {
    key: 'deprecie',
    label: 'Vault déprécié — un prêt impairé, un prêt impairé puis réhabilité',
    asset: 'XRP', depots: [25, 20], borrowers: 2,
    brokers: [{ coverRateMinimum: 10000, coverRateLiquidation: 50000, cover: 5, debtMaximum: XRP(40) }],
    loans: [
      { broker: 0, principal: 8, borrower: 'external', action: { impair: true } },
      { broker: 0, principal: 7, borrower: 'external', action: { unimpair: true } },
    ],
  },
  {
    key: 'iou',
    label: 'Vault IOU — actif émis par un tiers qui a AllowTrustLineClawback (position saisissable)',
    asset: 'IOU', scale: 6, depots: [80, 60], borrowers: 1,
    brokers: [{ coverRateMinimum: 10000, coverRateLiquidation: 50000, cover: 20, debtMaximum: '0' }],
    loans: [
      { broker: 0, principal: 40, borrower: 'external', action: { leave: true } },
    ],
  },
  {
    key: 'verrouille',
    label: 'Vault à parts NON transférables — aucun marché secondaire possible',
    asset: 'XRP', shareNonTransferable: true, depots: [20, 15], borrowers: 1,
    brokers: [{ coverRateMinimum: 10000, coverRateLiquidation: 50000, cover: 4, debtMaximum: XRP(30) }],
    loans: [
      { broker: 0, principal: 6, borrower: 'external', action: { pay: 4 } },
    ],
  },
  {
    key: 'redemption',
    label: 'Vault déjà en phase Redemption — la sortie normale des déposants est testable',
    asset: 'XRP', dates: { subscriptionIn: 45, investmentFor: 180 },
    depots: [18, 12], borrowers: 0, brokers: [], loans: [],
  },
  {
    key: 'solde',
    label: 'Vault avec un prêt soldé puis supprimé (LoanDelete) — fin de vie propre',
    asset: 'XRP', depots: [30], borrowers: 1,
    brokers: [{ coverRateMinimum: 10000, coverRateLiquidation: 50000, cover: 5, debtMaximum: XRP(30) }],
    loans: [
      { broker: 0, principal: 6, borrower: 'external', interval: 120, total: 1, action: { settle: true } },
    ],
  },
]

// ─────────────────────────────────────────────────────────────
const c = await connect()
log('Devnet connecté.\n')

// 1. Financement (séquentiel : le faucet est partagé et throttle).
log('1. Financement des comptes…')
const fund = async () => fundAccount()
const issuer = await fund()           // autorité KYC + émetteur de l'IOU
const nonMembre = await fund()        // jamais crédentialisé
const mondes = []
for (const p of PROFILS) {
  const owner = await fund()
  const deposants = []
  for (let i = 0; i < p.depots.length; i++) deposants.push(await fund())
  const emprunteurs = []
  for (let i = 0; i < (p.borrowers ?? 0); i++) emprunteurs.push(await fund())
  mondes.push({ profil: p, owner, deposants, emprunteurs })
}
await sleep(6000)
const nComptes = 2 + mondes.reduce((s, m) => s + 1 + m.deposants.length + m.emprunteurs.length, 0)
log(`   ${nComptes} comptes financés · émetteur ${issuer.classicAddress}`)
log(`   non-membre ${nonMembre.classicAddress} (sert à démontrer le gate)\n`)

// 2. IOU : l'émetteur ouvre le rippling ET s'arme du clawback (le signal du vault iou).
log('2. Émetteur IOU (DefaultRipple + AllowTrustLineClawback)…')
await submit(c, { TransactionType: 'AccountSet', Account: issuer.classicAddress, SetFlag: 8 }, issuer)
await submit(c, { TransactionType: 'AccountSet', Account: issuer.classicAddress, SetFlag: 16 }, issuer)
const iouMondes = mondes.filter(m => m.profil.asset === 'IOU')
const usd = v => ({ currency: 'USD', issuer: issuer.classicAddress, value: String(v) })
for (const m of iouMondes) {
  const beneficiaires = [m.owner, ...m.deposants]
  for (const w of beneficiaires) {
    await submit(c, { TransactionType: 'TrustSet', Account: w.classicAddress,
      LimitAmount: { currency: 'USD', issuer: issuer.classicAddress, value: '1000000' } }, w)
    await submit(c, { TransactionType: 'Payment', Account: issuer.classicAddress,
      Destination: w.classicAddress, Amount: usd(1000) }, issuer)
  }
}
log(`   ${iouMondes.length} vault(s) IOU approvisionné(s) en USD.\n`)

// 3. Credentials + domaine permissionné.
log('3. Credentials et domaine permissionné…')
const sujets = mondes.flatMap(m => [m.owner, ...m.deposants, ...m.emprunteurs])
await Promise.all(sujets.map(s => issueCredential(c, { issuer, subject: s })))
const dom = await createDomain(c, { owner: issuer, issuer })
if (!dom.domainId) throw new Error(`PermissionedDomainSet: ${dom.result}`)
log(`   ${sujets.length} credentials émis et acceptés · DomainID ${dom.domainId}\n`)

// 4. Vaults.
log('4. Vaults privés closed-ended…')
await Promise.all(mondes.map(async m => {
  const p = m.profil
  const v = await createVault(c, m.owner, {
    asset: p.asset === 'IOU' ? { currency: 'USD', issuer: issuer.classicAddress } : { currency: 'XRP' },
    subscriptionIn: p.dates?.subscriptionIn ?? SUBSCRIPTION_IN,
    investmentFor: p.dates?.investmentFor ?? INVESTMENT_FOR,
    assetsMaximum: '0',
    domainId: dom.domainId,
    scale: p.scale ?? null,
    shareNonTransferable: Boolean(p.shareNonTransferable),
    data: p.label,
  })
  if (!v.vaultId) throw new Error(`VaultCreate ${p.key}: ${v.result} ${v.message ?? ''}`)
  Object.assign(m, { vaultId: v.vaultId, mptId: v.mptId, vault: v.vault,
    subscriptionDate: v.subscriptionDate, redemptionDate: v.redemptionDate })
  log(`   ${p.key.padEnd(12)} ${v.vaultId}`)
}))
log()

// 5. Dépôts (phase Subscription).
log('5. Dépôts (phase Subscription)…')
await Promise.all(mondes.flatMap(m =>
  m.deposants.map(async (d, i) => {
    const amt = m.profil.asset === 'IOU' ? usd(m.profil.depots[i]) : XRP(m.profil.depots[i])
    const r = await deposit(c, d, m.vaultId, amt)
    if (!r.ok) log(`   ⚠️ ${m.profil.key} dépôt ${i}: ${r.result} ${r.message ?? ''}`)
  })))
const refus = await deposit(c, nonMembre, mondes[0].vaultId, XRP(10))
log(`   dépôts posés · non-membre → ${refus.result} ${refus.result === 'tecNO_AUTH' ? '✓ gate actif' : '⚠️ inattendu'}\n`)

// 5b. Wallets externes : on émet le KYC, chacun l'accepte dans son extension, puis dépose.
if (INVITES.length) {
  log(`5b. Invitations (${INVITES.length})…`)
  for (const invite of INVITES) {
    try {
      await c.request({ command: 'account_info', account: invite, ledger_index: 'validated' })
    } catch {
      throw new Error(`${invite} n'existe pas encore sur le Devnet — faucet d'abord : https://faucet.devnet.rippletest.net/accounts`)
    }
    const cred = await createCredential(c, { issuer, subject: invite })
    if (!cred.ok) throw new Error(`CredentialCreate ${invite}: ${cred.result} ${cred.message ?? ''}`)
    log(`   credential KYC → ${invite}  ✓`)
  }
  const sain = mondes.find(m => m.profil.key === 'sain')
  const reste = Math.max(0, (sain?.subscriptionDate ?? 0) - rippleNow())
  log(`\n   À faire MAINTENANT, chacun dans son extension (réseau Devnet) :`)
  log(`   1. accepter le credential KYC émis par ${issuer.classicAddress}`)
  log(`   2. déposer du XRP dans le vault sain :`)
  log(`      ${sain.vaultId}`)
  log(`      https://devnet.xrpl.org/vaults/${sain.vaultId}`)
  log(`   ⏳ ~${reste}s avant la clôture de Subscription — après, VaultDeposit = tecTOO_SOON.\n`)
}

// 6. Brokers + first-loss capital.
log('6. Brokers et first-loss capital…')
await Promise.all(mondes.map(async m => {
  m.brokers = []
  for (const b of m.profil.brokers ?? []) {
    const r = await createBroker(c, m.owner, m.vaultId, b)
    if (!r.brokerId) { log(`   ⚠️ ${m.profil.key} broker: ${r.result} ${r.message ?? ''}`); continue }
    if (b.cover > 0) {
      const amt = m.profil.asset === 'IOU' ? usd(b.cover) : XRP(b.cover)
      await coverDeposit(c, m.owner, r.brokerId, amt)
    }
    m.brokers.push({ id: r.brokerId, ...b })
    log(`   ${m.profil.key.padEnd(12)} broker ${r.brokerId.slice(0, 10)}… cover ${b.cover}`
      + ` (min ${b.coverRateMinimum / 1000}% / liq ${b.coverRateLiquidation / 1000}%)`)
  }
}))
log()

// 7. Attente de la phase Investment (calée sur les vaults à fenêtre standard).
{
  const stdMonde = mondes.find(m => !m.profil.dates)
  const w = stdMonde.subscriptionDate - rippleNow() + 12
  if (w > 0) { log(`7. Attente de la phase Investment — ${w}s…\n`); await sleep(w * 1000) }
}

// 8. Origination des prêts (phase Investment).
log('8. Origination des prêts…')
await Promise.all(mondes.map(async m => {
  m.prets = []
  let extIdx = 0
  for (let i = 0; i < (m.profil.loans ?? []).length; i++) {
    const spec = m.profil.loans[i]
    const borrower = spec.borrower === 'owner' ? m.owner : m.emprunteurs[extIdx++]
    const r = await createLoan(c, borrower, m.owner, m.brokers[spec.broker].id, {
      principal: m.profil.asset === 'IOU' ? String(spec.principal) : XRP(spec.principal),
      paymentInterval: spec.interval ?? 120,
      paymentTotal: spec.total ?? 3,
      gracePeriod: spec.grace ?? 60,
      interestRate: 50000,
      originationFee: m.profil.asset === 'IOU' ? null : XRP(0.1),
      serviceFee: m.profil.asset === 'IOU' ? null : XRP(0.01),
      latePaymentFee: m.profil.asset === 'IOU' ? null : XRP(0.05),
      redemptionDate: m.redemptionDate,   // active la validation de marge de fin
    })
    if (!r.loanId) { log(`   ⚠️ ${m.profil.key} prêt ${i}: ${r.result} ${r.message ?? ''}`); continue }
    // ⚠️ spec en premier : sinon spec.borrower ('external'/'owner') écrase le Wallet.
    m.prets.push({ ...spec, id: r.loanId, wallet: borrower, borrowerAddr: borrower.classicAddress })
    const flag = spec.borrower === 'owner' ? ' 🔴 AUTO-PRÊT' : ''
    log(`   ${m.profil.key.padEnd(12)} prêt ${spec.principal} → ${r.loanId.slice(0, 10)}…${flag}`)
  }
}))
log()

// 9. Paiements immédiats (dans la première période).
log('9. Paiements dans la période…')
await Promise.all(mondes.flatMap(m => (m.prets ?? []).map(async p => {
  if (p.action?.pay && m.profil.asset !== 'IOU') {
    const r = await payLoan(c, p.wallet, p.id, XRP(p.action.pay))
    log(`   ${m.profil.key.padEnd(12)} LoanPay ${p.action.pay} XRP → ${r.result}`)
  }
})))
log()

// 10. Passage du temps : au-delà de échéance + grâce (≈180 s après origination).
const differe = mondes.some(m => (m.prets ?? []).some(p =>
  p.action?.impair || p.action?.unimpair || p.action?.settle || p.action?.leave))
if (differe) {
  log('10. Attente 195s (échéance + grâce) pour impairment / défaillance / solde…\n')
  await sleep(195_000)
}

// 11. Détresse et fin de vie.
log('11. Impairment, réhabilitation, solde…')
for (const m of mondes) {
  for (const p of m.prets ?? []) {
    if (p.action?.impair) {
      const r = await impair(c, m.owner, p.id)
      log(`   ${m.profil.key.padEnd(12)} tfLoanImpair → ${r.result}`)
    }
    if (p.action?.unimpair) {
      const a = await impair(c, m.owner, p.id)
      const b = await unimpair(c, m.owner, p.id)
      log(`   ${m.profil.key.padEnd(12)} impair→unimpair → ${a.result}/${b.result}`)
    }
    if (p.action?.settle && m.profil.asset !== 'IOU') {
      // Après la grâce, il faut le flag tfLoanLatePayment (0x00040000) [F-77/X3].
      const pay = await payLoan(c, p.wallet, p.id, XRP(p.principal * 1.5), 0x00040000)
      const del = pay.ok ? await deleteLoan(c, p.wallet, p.id) : { result: 'skip (paiement échoué)' }
      log(`   ${m.profil.key.padEnd(12)} solde: LoanPay(late) ${pay.result} · LoanDelete ${del.result}`)
    }
  }
}
log()

// 12. Snapshot + world + state.
log('12. Snapshot de chaque vault…')
const world = {
  generatedAt: new Date().toISOString(),
  network: 'wss://s.devnet.rippletest.net:51233',
  issuer: issuer.classicAddress,
  domainId: dom.domainId,
  nonMember: nonMembre.classicAddress,
  guest: INVITES[0] ?? null,
  guests: INVITES,
  vaults: [],
}
const snapshot = {
  generatedAt: world.generatedAt,
  capturedAtRipple: String(rippleNow()),
  note: 'Dump hors ligne pour l\'analyste. Les statuts de prêt (défaillable, en grâce) sont figés à capturedAtRipple.',
  vaults: {},
}

// L'émetteur est-il armé du clawback ? (signal du vault iou)
const issuerInfo = await c.request({ command: 'account_info', account: issuer.classicAddress, ledger_index: 'validated' })
const clawbackArmed = Boolean(Number(issuerInfo.result.account_data.Flags ?? 0) & LSF_ALLOW_CLAWBACK)

for (const m of mondes) {
  const g = await readVaultGraph(c, m.vaultId)
  const h = await holderMap(c, g.vault)
  const isIou = m.profil.asset === 'IOU'
  log(`\n   ── ${m.profil.key} · phase ${g.phase} · NAV/part ${g.metrics.navPerShare}`
    + ` · util ${g.metrics.utilisation ?? 0} · ${h.count} détenteurs (HHI ${h.hhi})`
    + ` · rejeu ${h.reconciles ? '✓' : '⚠️ DIVERGENT'}`)
  for (const b of g.brokers)
    log(`      broker cover ${b.metrics.coverAvailable} dette ${b.metrics.debtTotal}`
      + `${b.metrics.noCover ? ' 🔴 0/0' : ''} · ${b.loans.length} prêt(s)`
      + b.loans.map(l => ` [${l.metrics.status}${l.metrics.selfLoan ? '/auto' : ''}]`).join(''))

  const entry = {
    key: m.profil.key, label: m.profil.label,
    vaultId: m.vaultId, pseudoAccount: g.vault.Account, owner: m.owner.classicAddress,
    shareMptId: m.mptId, asset: isIou ? 'IOU' : 'XRP',
    assetIssuer: isIou ? issuer.classicAddress : null,
    clawbackArmed: isIou ? clawbackArmed : false,
    subscriptionDate: m.subscriptionDate, redemptionDate: m.redemptionDate,
  }
  world.vaults.push({
    ...entry,
    holders: h.holders.map(x => ({ account: x.account, shares: x.shares.toString() })),
    brokers: (m.brokers ?? []).map(b => ({ brokerId: b.id })),
    loans: (m.prets ?? []).map(p => ({ loanId: p.id, borrower: p.borrowerAddr })),
  })
  snapshot.vaults[m.profil.key] = { meta: entry, graph: g, holders: h }
}

const seeds = {
  issuer: issuer.seed, nonMember: nonMembre.seed,
  vaults: Object.fromEntries(mondes.map(m => [m.profil.key, {
    owner: m.owner.seed,
    depositors: m.deposants.map(d => d.seed),
    borrowers: m.emprunteurs.map(b => b.seed),
  }])),
}

writeFileSync(join(HERE, '..', 'world.json'), jsonBig(world))
writeFileSync(join(HERE, '..', 'state.json'), jsonBig(seeds))
writeFileSync(join(HERE, '..', 'snapshot.json'), jsonBig(snapshot))
const webData = join(HERE, '..', 'apps', 'web', 'public', 'data')
mkdirSync(webData, { recursive: true })
writeFileSync(join(webData, 'world.json'), jsonBig(world))
writeFileSync(join(webData, 'snapshot.json'), jsonBig(snapshot))
log('\n   world.json    — identifiants publics [committé]')
log('   state.json    — ⚠️ seeds, gitignoré')
log('   snapshot.json — dump hors ligne pour l\'analyste [committé]')
log('   apps/web/public/data — copie pour le site statique / Vercel')
log(`\n   ${world.vaults.length} vaults générés. clawbackArmed(iou)=${clawbackArmed}`)

await c.disconnect()
