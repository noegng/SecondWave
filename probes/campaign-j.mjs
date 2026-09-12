// Campagne J — limites et cas tordus (107-114).
// Réutilise les wallets du smoke test : `longlived` détient des parts du vault
// smoke depuis le début de session (>256 ledgers) → AccountDelete testable.
import fs from 'node:fs'
import {
  startCampaign, vaultCreate, depositTx, withdrawTx,
  submit, safeLoanSet, createdIndex, rippleNow, sleep, XRP, Wallet,
} from './_lib.mjs'

const smoke = JSON.parse(fs.readFileSync(new URL('./state-smoke.json', import.meta.url), 'utf8'))
const cx = await startCampaign('j')
const A = Wallet.fromSeed(smoke.wallets.alice.seed)        // owner smoke
const LL = Wallet.fromSeed(smoke.wallets.longlived.seed)   // candidat AccountDelete
const { J1 } = await cx.fundMany(['J1'])
const smokeVault = (await cx.request({ command: 'vault_info', vault_id: smoke.vaultId })).vault
const pseudo = smokeVault.Account
cx.note('J0', `vault smoke: pseudo=${pseudo} AssetsTotal=${smokeVault.AssetsTotal ?? 0}`)

// ── 108 : Payment direct vers le pseudo-compte
cx.rec('108', 'Payment 1 XRP → pseudo-compte du vault', '', await submit(cx.client, {
  TransactionType: 'Payment', Account: J1.classicAddress, Destination: pseudo, Amount: XRP(1),
}, J1))

// ── 113 : Escrow / Check / PaymentChannel vers le pseudo-compte
cx.rec('113.escrow', 'EscrowCreate → pseudo', '', await submit(cx.client, {
  TransactionType: 'EscrowCreate', Account: J1.classicAddress, Destination: pseudo,
  Amount: XRP(1), FinishAfter: rippleNow() + 3600,
}, J1))
cx.rec('113.check', 'CheckCreate → pseudo', '', await submit(cx.client, {
  TransactionType: 'CheckCreate', Account: J1.classicAddress, Destination: pseudo, SendMax: XRP(1),
}, J1))
cx.rec('113.paychan', 'PaymentChannelCreate → pseudo', '', await submit(cx.client, {
  TransactionType: 'PaymentChannelCreate', Account: J1.classicAddress, Destination: pseudo,
  Amount: XRP(1), SettleDelay: 60, PublicKey: J1.publicKey,
}, J1))

// ── 107 : AssetsMaximum abaissé sous AssetsTotal (vault smoke: 10 XRP dedans)
cx.rec('107.under', 'VaultSet AssetsMaximum=5 XRP < AssetsTotal=10 XRP', '', await submit(cx.client, {
  TransactionType: 'VaultSet', Account: A.classicAddress, VaultID: smoke.vaultId, AssetsMaximum: XRP(5),
}, A))
cx.rec('107.exact', 'VaultSet AssetsMaximum=AssetsTotal exactement', '', await submit(cx.client, {
  TransactionType: 'VaultSet', Account: A.classicAddress, VaultID: smoke.vaultId, AssetsMaximum: String(smokeVault.AssetsTotal ?? XRP(10)),
}, A))
cx.rec('107.zero', 'VaultSet AssetsMaximum=0 (retour à illimité)', '', await submit(cx.client, {
  TransactionType: 'VaultSet', Account: A.classicAddress, VaultID: smoke.vaultId, AssetsMaximum: '0',
}, A))

// ── 109 : les tx XLS-65/66 dans un Batch
{
  const { BatchFlags } = await import('xrpl')
  const seqInfo = await cx.request({ command: 'account_info', account: J1.classicAddress, ledger_index: 'current' })
  const s = seqInfo.account_data.Sequence
  const li = (await cx.request({ command: 'ledger', ledger_index: 'validated' })).ledger_index
  const TF_INNER = 0x40000000
  const batch = {
    TransactionType: 'Batch', Account: J1.classicAddress, Flags: BatchFlags.tfAllOrNothing,
    RawTransactions: [
      { RawTransaction: { TransactionType: 'VaultDeposit', Account: J1.classicAddress, VaultID: smoke.vaultId, Amount: XRP(1), Sequence: s + 1, Fee: '0', SigningPubKey: '', Flags: TF_INNER } },
      { RawTransaction: { TransactionType: 'Payment', Account: J1.classicAddress, Destination: A.classicAddress, Amount: '1000', Sequence: s + 2, Fee: '0', SigningPubKey: '', Flags: TF_INNER } },
    ],
    Sequence: s, Fee: '100', LastLedgerSequence: li + 30,
  }
  const f = await cx.fire(batch, J1, { seq: s })
  const fin = f.hash ? await cx.finalOf(f.hash, 12) : { result: f.engine }
  cx.rec('109', 'Batch [VaultDeposit + Payment] tfAllOrNothing', `prelim ${f.engine} ${f.message ?? ''}`, fin.result ?? f.engine)
}

// ── 110/111/114 : vault closed dédié (owner privilège, self-loan, réserves)
const ai = async a => (await cx.request({ command: 'account_info', account: a, ledger_index: 'validated' })).account_data
{
  const before = await ai(J1.classicAddress)
  const sub = rippleNow() + 70
  const red = sub + 300
  const V = await vaultCreate(cx.client, J1, {
    Asset: { currency: 'XRP' }, AssetsMaximum: '0', VaultKind: 1,
    SubscriptionDate: sub, RedemptionDate: red, WithdrawalPolicy: 1,
  })
  cx.rec('J.V', 'VaultCreate (J1)', '', V)
  const afterVault = await ai(J1.classicAddress)
  cx.note('114', `VaultCreate: OwnerCount J1 ${before.OwnerCount}→${afterVault.OwnerCount} | Balance delta=${BigInt(afterVault.Balance) - BigInt(before.Balance)} drops`)
  const pv = await ai(V.vault.Account)
  cx.note('114', `pseudo-compte vault: Balance=${pv.Balance} OwnerCount=${pv.OwnerCount} Flags=${pv.Flags}`)

  cx.rec('110.dep', 'le propriétaire dépose 20 XRP (Subscription)', '', await submit(cx.client, depositTx(J1, V.vaultId, XRP(20)), J1))
  const rb = await submit(cx.client, {
    TransactionType: 'LoanBrokerSet', Account: J1.classicAddress, VaultID: V.vaultId,
    DebtMaximum: '0', CoverRateMinimum: 0, CoverRateLiquidation: 0, ManagementFeeRate: 0,
  }, J1)
  const BID = createdIndex(rb, 'LoanBroker')
  cx.rec('J.B', 'LoanBrokerSet (J1 = owner ET broker)', '', rb)
  const afterBroker = await ai(J1.classicAddress)
  cx.note('114', `LoanBrokerSet: OwnerCount J1 →${afterBroker.OwnerCount} | pseudo-broker: ${BID ? JSON.stringify(await ai((await cx.entry(BID)).Account).then(x => ({ Balance: x.Balance, OwnerCount: x.OwnerCount }))) : '?'}`)

  {
    const wait = sub - rippleNow() + 6
    if (wait > 0) { cx.log(`attente Investment (${wait}s)…`); await sleep(wait * 1000) }
  }
  // 110 : le propriétaire subit-il les mêmes murs de phase ?
  cx.rec('110.wd', 'le propriétaire retire en Investment (privilège ?)', '', await submit(cx.client, withdrawTx(J1, V.vaultId, V.mptId, 1_000_000), J1))

  // 111 : emprunteur = broker owner (self-loan des deux côtés)
  const rself = await safeLoanSet(cx.client, {
    TransactionType: 'LoanSet', Account: J1.classicAddress, LoanBrokerID: BID,
    PrincipalRequested: XRP(5), PaymentInterval: 120, PaymentTotal: 1, GracePeriod: 60, InterestRate: 0,
  }, J1, J1)
  cx.rec('111', 'LoanSet où emprunteur = broker owner = counterparty (self-loan)', '', rself)
  const afterLoan = await ai(J1.classicAddress)
  cx.note('114', `après LoanSet self: OwnerCount J1=${afterLoan.OwnerCount} | Balance=${afterLoan.Balance}`)
}

// ── 112 : AccountDelete d'un compte qui détient des parts
{
  const seqNow = (await cx.request({ command: 'ledger', ledger_index: 'validated' })).ledger_index
  cx.note('112', `ledger courant ${seqNow}, seuil AccountDelete ≈ ${smoke.accountSeq + 256}`)
  const r = await submit(cx.client, {
    TransactionType: 'AccountDelete', Account: LL.classicAddress, Destination: A.classicAddress, Fee: XRP(0.2),
  }, LL)
  cx.rec('112', 'AccountDelete de longlived (détient 10e6 parts du vault smoke)', '', r)
  if (!r.ok) {
    // qu'est-ce qui bloque ? on vide les parts puis on retente
    const sb = (await import('@secondwave/core')).shareBalance
    const bal = await sb(cx.client, LL.classicAddress, smoke.mptId)
    if (bal.holds && bal.amount > 0n) {
      await submit(cx.client, withdrawTx(LL, smoke.vaultId, smoke.mptId, bal.amount), LL)
      await submit(cx.client, { TransactionType: 'MPTokenAuthorize', Account: LL.classicAddress, MPTokenIssuanceID: smoke.mptId, Flags: 1 }, LL)
      cx.rec('112.retry', 'AccountDelete après retrait des parts + fermeture du MPToken', '', await submit(cx.client, {
        TransactionType: 'AccountDelete', Account: LL.classicAddress, Destination: A.classicAddress, Fee: XRP(0.2),
      }, LL))
    }
  }
}

await cx.done()
