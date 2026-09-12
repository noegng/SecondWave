// Smoke test du harnais + préparation du compte longue durée pour J112
// (AccountDelete exige ~256 ledgers d'ancienneté : on le crée tout de suite,
//  on le fait déposer dans un vault, la campagne J tentera la suppression).
import { startCampaign, vaultCreate, depositTx, submit, XRP } from './_lib.mjs'

const cx = await startCampaign('smoke')
const { alice, longlived } = await cx.fundMany(['alice', 'longlived'])

const v = await vaultCreate(cx.client, alice, {
  Asset: { currency: 'XRP' }, AssetsMaximum: '0', WithdrawalPolicy: 1,
})
cx.rec('S1', 'VaultCreate open-ended (smoke)', 'VaultCreate XRP', v)
cx.note('S1', `vaultId=${v.vaultId} mptId=${v.mptId} LEVersion=${v.vault?.LEVersion ?? '(absent)'} VaultKind=${v.vault?.VaultKind ?? '(absent)'}`)

const d = await submit(cx.client, depositTx(longlived, v.vaultId, XRP(10)), longlived)
cx.rec('S2', 'longlived dépose 10 XRP', 'VaultDeposit 10 XRP', d)

const seqInfo = await cx.request({ command: 'account_info', account: longlived.classicAddress, ledger_index: 'validated' })
const lgr = await cx.request({ command: 'ledger', ledger_index: 'validated' })
cx.saveState({ vaultId: v.vaultId, mptId: v.mptId, accountSeq: seqInfo.account_data.Sequence, ledgerAtCreation: lgr.ledger_index })
cx.note('S3', `ledger courant=${lgr.ledger_index}, AccountDelete possible vers ledger ${seqInfo.account_data.Sequence + 256}`)

await cx.done()
