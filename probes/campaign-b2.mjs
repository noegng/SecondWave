// Campagne B2 — la bascule de phase à la seconde près (22-23).
// 5 déposants tirent la même transaction à sub−2, −1, 0, +1, +2 (puis à red±2)
// sans attendre la validation ; on relit ensuite code final + ledger + close_time.
import {
  startCampaign, vaultCreate, depositTx, withdrawTx,
  submit, rippleNow, sleep, XRP,
} from './_lib.mjs'

const cx = await startCampaign('b2')
const names = ['O', 'd1', 'd2', 'd3', 'd4', 'd5']
const w = await cx.fundMany(names)
const ds = [w.d1, w.d2, w.d3, w.d4, w.d5]

const sub = rippleNow() + 150
const red = sub + 240
const V = await vaultCreate(cx.client, w.O, {
  Asset: { currency: 'XRP' }, AssetsMaximum: '0', VaultKind: 1,
  SubscriptionDate: sub, RedemptionDate: red, WithdrawalPolicy: 1,
})
cx.rec('B2.0', 'VaultCreate', `sub=${sub} red=${red}`, V)
for (const d of ds) await submit(cx.client, depositTx(d, V.vaultId, XRP(5)), d)
cx.note('B2.0', '5 déposants provisionnés en Subscription')

async function boundary(tag, when, mkTx) {
  const offsets = [-2, -1, 0, 1, 2]
  // pré-signer au plus près : on attend when-4s
  const lead = when - rippleNow() - 4
  if (lead > 0) { cx.log(`attente frontière ${tag} (${lead}s)…`); await sleep(lead * 1000) }
  const fired = []
  for (const off of offsets) {
    const target = when + off
    let ms = (target - rippleNow()) * 1000 - 100
    if (ms > 0) await sleep(ms)
    const d = ds[offsets.indexOf(off)]
    const f = await cx.fire(mkTx(d), d)
    fired.push({ off, d, f, at: rippleNow() })
  }
  for (const { off, f, at } of fired) {
    if (!f.hash) { cx.rec(`${tag}.${off}`, `${tag} à t${off >= 0 ? '+' : ''}${off}s`, `soumis à ${at - when}s`, f.engine); continue }
    const fin = await cx.finalOf(f.hash, 15)
    cx.rec(`${tag}.${off}`, `${tag} à t${off >= 0 ? '+' : ''}${off}s`, `soumis à ${at - when}s, prelim ${f.engine}`,
      fin.result, '', `ledger ${fin.ledger} close_time=${fin.close} (close−frontière=${fin.close != null ? fin.close - when : '?'}s)`)
  }
}

// 22 : à SubscriptionDate, le dépôt bascule de permis → interdit
await boundary('22.dep', sub, d => depositTx(d, V.vaultId, XRP(1)))
// 23 : à RedemptionDate, le retrait bascule d'interdit → permis
await boundary('23.wd', red, d => withdrawTx(d, V.vaultId, V.mptId, 1_000_000))

// granularité des close_time sur ce Devnet
{
  const l = await cx.request({ command: 'ledger', ledger_index: 'validated' })
  cx.note('B2', `dernier ledger: ${l.ledger_index} close_time=${l.ledger.close_time} close_time_resolution=${l.ledger.close_time_resolution ?? '?'} | rippleNow=${rippleNow()}`)
}

await cx.done()
