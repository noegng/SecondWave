/**
 * probes-marche/07b-reserve-exacte.mjs — suivi de C30/31.
 * Le seuil de trésorerie de l'acheteur est base + inc×(OwnerCount+1), où +1 est
 * l'objet MPToken créé par le swap. On le mesure au drop près : un swap qui
 * laisse exactement ce solde doit passer, un drop de moins doit échouer.
 */
import {
  connect, sleep, loadState, walletsOf, recap, sendRaw, swapBatch,
  shareBalance, xrpBalance, fundFromTreasury, issueCredentialRaw, acceptCredential, XRP,
} from './_lib.mjs'

const S = loadState('marche')
const W = walletsOf(S)
const c = await connect()
const V1 = S.vaults.V1
const R = []
const note = (cas, question, reponse, verdict) => { R.push({ cas, question, reponse, verdict }); console.log(`  [${cas}] ${reponse}\n        → ${verdict}`) }

const si = await c.request({ command: 'server_info' })
const BASE = BigInt(Math.round(si.result.info.validated_ledger.reserve_base_xrp * 1e6))
const INC = BigInt(Math.round(si.result.info.validated_ledger.reserve_inc_xrp * 1e6))
console.log(`réserves Devnet : base=${XRP(BASE)} XRP · inc=${XRP(INC)} XRP`)

const mk = async () => {
  const w = await fundFromTreasury(c, W.treasury, '9000000')
  await issueCredentialRaw(c, W.issuer, w.classicAddress, 'KYC')
  await acceptCredential(c, w, W.issuer, 'KYC')
  return w
}

const runAt = async (buyer, delta) => {
  const ai = await c.request({ command: 'account_info', account: buyer.classicAddress, ledger_index: 'validated' })
  const bal = BigInt(ai.result.account_data.Balance)
  const owners = BigInt(ai.result.account_data.OwnerCount)
  const keep = BASE + INC * (owners + 1n) + delta        // +1 : l'objet MPToken à créer
  const price = bal - keep
  const b = await swapBatch(c, { seller: W.seller1, buyer, mptId: V1.mptId,
    shares: 10_000, price: price.toString(), authorize: true })
  const r = await sendRaw(c, b)
  await sleep(3000)
  const got = (await shareBalance(c, buyer.classicAddress, V1.mptId)).amount
  return { bal, owners, keep, price, r, got }
}

console.log('\n══ C30\' · Le seuil exact, calculé sur OwnerCount ══')
{
  const b1 = await mk(), b2 = await mk()
  await sleep(2000)
  const exact = await runAt(b1, 0n)      // garde exactement base + inc×(owners+1)
  const below = await runAt(b2, -1n)     // un drop de moins
  console.log(`    owners=${exact.owners} garde ${XRP(exact.keep)} XRP : ${exact.r.engine}→${exact.r.validated} · parts ${exact.got}`)
  console.log(`    owners=${below.owners} garde ${XRP(below.keep)} XRP : ${below.r.engine}→${below.r.validated} · parts ${below.got}`)
  note('C30', 'seuil exact de solde acheteur',
    `au seuil base+inc×(owners+1): ${exact.got > 0n ? 'PASSE' : 'échoue'} · 1 drop sous le seuil: ${below.got > 0n ? 'passe' : 'échoue (silencieusement, tesSUCCESS)'}`,
    exact.got > 0n && below.got === 0n
      ? `seuil EXACT = réserve base ${XRP(BASE)} + ${XRP(INC)}×(OwnerCount+1) · l'objet MPToken compte AVANT que le prix parte`
      : 'seuil encore différent — creuser l\'ordre reserve-check vs paiement dans la jambe')
}

recap(R, 'C30 — RÉSERVE EXACTE')
await c.disconnect()
