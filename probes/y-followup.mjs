// Y — dernières vérifications au drop près :
//  1. plancher exact de LoanBrokerCoverWithdraw : DebtTotal × CoverRateLiquidation ?
//  2. update des DEUX CoverRate ensemble (le SDK laisse passer ?) → verdict serveur
import fs from 'node:fs'
import { startCampaign, submit, Wallet } from './_lib.mjs'

const st = JSON.parse(fs.readFileSync(new URL('./state-x.json', import.meta.url), 'utf8'))
const cx = await startCampaign('y')
const XO = Wallet.fromSeed(st.wallets.XO.seed)

const b = await cx.entry(st.BK)
const debt = BigInt(b.DebtTotal ?? 0)
const cover = BigInt(b.CoverAvailable ?? 0)
cx.note('Y1', `broker: debt=${debt} cover=${cover} min=${b.CoverRateMinimum} liq=${b.CoverRateLiquidation}`)

// hypothèse : plancher = debt × liq / 1e5 (arrondi ?)
const floorLiq = debt * BigInt(b.CoverRateLiquidation) / 100000n
if (cover > floorLiq) {
  cx.rec('Y1.a', `retirer jusqu'à laisser floorLiq+1 (${floorLiq + 1n})`, `retrait ${cover - floorLiq - 1n}`,
    await submit(cx.client, {
      TransactionType: 'LoanBrokerCoverWithdraw', Account: XO.classicAddress, LoanBrokerID: st.BK, Amount: String(cover - floorLiq - 1n),
    }, XO))
  const c2 = BigInt((await cx.entry(st.BK)).CoverAvailable ?? 0)
  cx.rec('Y1.b', `retirer 1 drop de plus (laisserait pile ${floorLiq})`, '',
    await submit(cx.client, {
      TransactionType: 'LoanBrokerCoverWithdraw', Account: XO.classicAddress, LoanBrokerID: st.BK, Amount: '1',
    }, XO))
  const c3 = BigInt((await cx.entry(st.BK)).CoverAvailable ?? 0)
  cx.rec('Y1.c', 'encore 1 drop (passerait SOUS floorLiq)', '',
    await submit(cx.client, {
      TransactionType: 'LoanBrokerCoverWithdraw', Account: XO.classicAddress, LoanBrokerID: st.BK, Amount: '1',
    }, XO))
  const c4 = BigInt((await cx.entry(st.BK)).CoverAvailable ?? 0)
  cx.note('Y1', `cover: ${cover} → ${c2} → ${c3} → ${c4} | floorLiq=${floorLiq} floorMin=${debt * BigInt(b.CoverRateMinimum) / 100000n}`)
}

// 2. update des deux CoverRate ensemble
cx.rec('Y2', 'LoanBrokerSet update CoverRateMinimum+Liquidation ensemble', '20000/60000',
  await submit(cx.client, {
    TransactionType: 'LoanBrokerSet', Account: XO.classicAddress, VaultID: st.V, LoanBrokerID: st.BK,
    CoverRateMinimum: 20000, CoverRateLiquidation: 60000,
  }, XO))
{
  const b2 = await cx.entry(st.BK)
  cx.note('Y2', `objet après tentative: min=${b2.CoverRateMinimum} liq=${b2.CoverRateLiquidation}`)
}

await cx.done()
