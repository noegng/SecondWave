// Campagne C — parts, comptabilité, arrondis (28-38).
// (29 et 33 sont mesurés dans F/G : le ratio ne peut bouger qu'après intérêt,
//  et l'intérêt exige un prêt, donc un closed-ended — croisement documenté.)
import {
  startCampaign, vaultCreate, depositTx, withdrawTx,
  submit, rippleNow, sleep, XRP, hex, shareBalance, holderMap,
} from './_lib.mjs'

const cx = await startCampaign('c')
const { W, I, m1, m2, m3 } = await cx.fundMany(['W', 'I', 'm1', 'm2', 'm3'])

// ══ vault XRP open-ended ══
const V = await vaultCreate(cx.client, W, { Asset: { currency: 'XRP' }, AssetsMaximum: '0', WithdrawalPolicy: 1 })
cx.rec('C0', 'VaultCreate XRP open-ended', '', V)
cx.saveState({ V: V.vaultId, mptId: V.mptId })
const vinfo = async (vid = V.vaultId) => (await cx.request({ command: 'vault_info', vault_id: vid })).vault

// ── 28 : premier dépôt, ratio parts/actif
{
  const r = await submit(cx.client, depositTx(W, V.vaultId, XRP(5)), W)
  const sb = await shareBalance(cx.client, W.classicAddress, V.mptId)
  cx.rec('28', 'premier dépôt 5 XRP', '', r, '', `parts reçues=${sb.amount} (ratio ${Number(sb.amount) / 5e6})`)
}

// ── 30 : dépôt de 1 drop, de 0
{
  const sb0 = await shareBalance(cx.client, W.classicAddress, V.mptId)
  const r1 = await submit(cx.client, depositTx(W, V.vaultId, '1'), W)
  const sb1 = await shareBalance(cx.client, W.classicAddress, V.mptId)
  cx.rec('30.1drop', 'dépôt de 1 drop', '', r1, '', `parts +${sb1.amount - sb0.amount}`)
  cx.rec('30.zero', 'dépôt de 0', '', await submit(cx.client, depositTx(W, V.vaultId, '0'), W))
}

// ── 32 : retirer plus de parts qu'on n'en a
{
  const sb = await shareBalance(cx.client, W.classicAddress, V.mptId)
  cx.rec('32', `retrait de ${sb.amount + 1n} parts (solde ${sb.amount})`, '', await submit(cx.client, withdrawTx(W, V.vaultId, V.mptId, sb.amount + 1n), W))
}

// ── 31 : retrait partiel puis total — l'objet MPToken meurt-il à 0 ?
{
  const sb = await shareBalance(cx.client, W.classicAddress, V.mptId)
  await submit(cx.client, withdrawTx(W, V.vaultId, V.mptId, sb.amount / 2n), W)
  const mid = await shareBalance(cx.client, W.classicAddress, V.mptId)
  const r = await submit(cx.client, withdrawTx(W, V.vaultId, V.mptId, mid.amount), W)
  const end = await shareBalance(cx.client, W.classicAddress, V.mptId)
  cx.rec('31', 'retrait partiel puis total', '', r, '',
    `après partiel: ${mid.amount} parts (objet ${mid.holds ? 'présent' : 'absent'}) ; après total: objet ${end.holds ? 'ENCORE LÀ (solde ' + end.amount + ')' : 'SUPPRIMÉ'}`)
}

// ── 34a : rafale XRP — 100 dépôts + 100 retraits de montants impairs
cx.log('\n=== 34a. rafale XRP (100 aller-retours, montants impairs) ===')
{
  const AMT = 333_337n
  let expected = 0n
  const v0 = await vinfo()
  const t0 = BigInt(v0.AssetsTotal ?? 0)
  const deps = Array.from({ length: 100 }, () => depositTx(W, V.vaultId, String(AMT)))
  const r1 = await cx.burst(deps, W)
  const okDep = r1.fired.filter(f => f.engine === 'tesSUCCESS').length
  const sb = await shareBalance(cx.client, W.classicAddress, V.mptId)
  const wds = Array.from({ length: 100 }, () => withdrawTx(W, V.vaultId, V.mptId, AMT))
  const r2 = await cx.burst(wds, W)
  const okWd = r2.fired.filter(f => f.engine === 'tesSUCCESS').length
  await sleep(6000)
  const v1 = await vinfo()
  const sb1 = await shareBalance(cx.client, W.classicAddress, V.mptId)
  // seuls les engine=tes préliminaires ont potentiellement appliqué ; on recompte via le ledger
  cx.rec('34a', 'rafale XRP 100×dépôt + 100×retrait de 333337 drops', `préliminaires: dep ${okDep}/100, wd ${okWd}/100`,
    'voir note', BigInt(v1.AssetsTotal ?? 0) === t0 ? 'aucune fuite' : 'ÉCART',
    `AssetsTotal ${t0}→${v1.AssetsTotal ?? 0} | parts W: ${sb.amount}→${sb1.amount} | Outstanding=${v1.shares.OutstandingAmount}`)
}

// ══ vault IOU Scale 6 ══
cx.log('\n=== IOU : préparation émetteur ===')
await submit(cx.client, { TransactionType: 'AccountSet', Account: I.classicAddress, SetFlag: 8 }, I)
for (const [w, amt] of [[W, '100000'], [m1, '1000']]) {
  await submit(cx.client, { TransactionType: 'TrustSet', Account: w.classicAddress, LimitAmount: { currency: 'USD', issuer: I.classicAddress, value: '1000000000' } }, w)
  await submit(cx.client, { TransactionType: 'Payment', Account: I.classicAddress, Destination: w.classicAddress, Amount: { currency: 'USD', issuer: I.classicAddress, value: amt } }, I)
}
const iou = v => ({ currency: 'USD', issuer: I.classicAddress, value: String(v) })
const usdBal = async a => {
  const l = (await cx.request({ command: 'account_lines', account: a, ledger_index: 'validated' })).lines
  return l.find(x => x.currency === 'USD')?.balance ?? '0'
}

const V6 = await vaultCreate(cx.client, W, { Asset: { currency: 'USD', issuer: I.classicAddress }, AssetsMaximum: '0', WithdrawalPolicy: 1, Scale: 6 })
cx.rec('C.iou6', 'vault IOU Scale 6', '', V6)

// ── 101/34b : précision et fuite sur Scale 6
if (V6.vaultId) {
  const b0 = await usdBal(W.classicAddress)
  const r = await submit(cx.client, depositTx(W, V6.vaultId, iou('3.333333333333333')), W)
  const sb = await shareBalance(cx.client, W.classicAddress, V6.mptId)
  const b1 = await usdBal(W.classicAddress)
  cx.rec('101.s6', 'dépôt 3.333333333333333 USD (15 décimales) en Scale 6', '', r, '',
    `parts=${sb.amount} | trustline ${b0}→${b1} (débité ${Number(b0) - Number(b1)}) | AssetsTotal=${(await vinfo(V6.vaultId)).AssetsTotal}`)
  // retrait de 1 part (= 1e-6 USD)
  const r2 = await submit(cx.client, withdrawTx(W, V6.vaultId, V6.mptId, 1), W)
  cx.rec('101.s6w', 'retrait de 1 part (10^-6 USD)', '', r2, '', `trustline=${await usdBal(W.classicAddress)}`)
  // 30 aller-retours à montant tordu
  let leak0 = await usdBal(W.classicAddress)
  for (let i = 0; i < 30; i++) {
    await submit(cx.client, depositTx(W, V6.vaultId, iou('0.7777777')), W)   // 7 décimales > Scale 6
    const s = await shareBalance(cx.client, W.classicAddress, V6.mptId)
    await submit(cx.client, withdrawTx(W, V6.vaultId, V6.mptId, s.amount), W)
  }
  const leak1 = await usdBal(W.classicAddress)
  const vf = await vinfo(V6.vaultId)
  cx.rec('34b', '30 aller-retours 0.7777777 USD (Scale 6)', '', 'voir note',
    Number(leak1) === Number(leak0) ? 'aucune fuite' : 'ÉCART',
    `trustline ${leak0}→${leak1} | vault AssetsTotal=${vf.AssetsTotal} Outstanding=${vf.shares.OutstandingAmount}`)
}

// ══ vault IOU Scale 18 (si légal) : saturation int64 des parts ══
const V18 = await vaultCreate(cx.client, W, { Asset: { currency: 'USD', issuer: I.classicAddress }, AssetsMaximum: '0', WithdrawalPolicy: 1, Scale: 18 })
cx.rec('C.iou18', 'vault IOU Scale 18', '', V18)
if (V18.vaultId) {
  const r9 = await submit(cx.client, depositTx(W, V18.vaultId, iou('9')), W)
  const sb = await shareBalance(cx.client, W.classicAddress, V18.mptId)
  cx.rec('34c.9', 'dépôt 9 USD en Scale 18 (9e18 parts, sous la borne int64)', '', r9, '', `parts=${sb.amount}`)
  const r10 = await submit(cx.client, depositTx(W, V18.vaultId, iou('1')), W)
  const sb2 = await shareBalance(cx.client, W.classicAddress, V18.mptId)
  cx.rec('34c.10', 'dépôt de 1 USD de plus (dépasserait 2^63−1 parts ?)', '', r10, '', `parts=${sb2.amount}`)
  // fuite d'arrondi en Scale 18
  const l0 = await usdBal(W.classicAddress)
  const base18 = (await shareBalance(cx.client, W.classicAddress, V18.mptId)).amount
  for (let i = 0; i < 15; i++) {
    await submit(cx.client, depositTx(W, V18.vaultId, iou('0.1234567891234567')), W)
    const s = await shareBalance(cx.client, W.classicAddress, V18.mptId)
    if (s.amount > base18) await submit(cx.client, withdrawTx(W, V18.vaultId, V18.mptId, s.amount - base18), W)
  }
  const l1 = await usdBal(W.classicAddress)
  const vf = await vinfo(V18.vaultId)
  cx.rec('34d', '15 aller-retours 0.1234567891234567 USD (Scale 18)', '', 'voir note',
    Number(l1) === Number(l0) ? 'aucune fuite' : 'ÉCART',
    `trustline ${l0}→${l1} | AssetsTotal=${vf.AssetsTotal} Outstanding=${vf.shares.OutstandingAmount}`)
}

// ══ 35/36/37/38 : transferts de parts et cohérence ══
cx.log('\n=== 35-38. transferts et holderMap ===')
await submit(cx.client, depositTx(m1, V.vaultId, XRP(10)), m1)
await submit(cx.client, depositTx(m2, V.vaultId, XRP(7)), m2)
// m3 s'autorise puis reçoit des parts de m1
cx.rec('35.auth', 'MPTokenAuthorize par m3', '', await submit(cx.client, {
  TransactionType: 'MPTokenAuthorize', Account: m3.classicAddress, MPTokenIssuanceID: V.mptId,
}, m3))
{
  const v0 = await vinfo()
  const r = await submit(cx.client, {
    TransactionType: 'Payment', Account: m1.classicAddress, Destination: m3.classicAddress,
    Amount: { mpt_issuance_id: V.mptId, value: '3000000' },
  }, m1)
  cx.rec('36.pay', 'transfert de 3e6 parts m1→m3', '', r)
  const v1 = await vinfo()
  const same = v0.AssetsTotal === v1.AssetsTotal && v0.AssetsAvailable === v1.AssetsAvailable
    && v0.shares.OutstandingAmount === v1.shares.OutstandingAmount
  cx.rec('36', 'le transfert change-t-il le vault ?', 'diff vault_info avant/après',
    same ? 'strictement identique' : 'A CHANGÉ', same ? 'attendu' : 'surprenant',
    same ? '' : JSON.stringify({ avant: v0, après: v1 }))
}
// 37 : tfMPTUnauthorize en détenant encore des parts
cx.rec('37', 'MPTokenAuthorize tfMPTUnauthorize avec solde non nul (m3)', '', await submit(cx.client, {
  TransactionType: 'MPTokenAuthorize', Account: m3.classicAddress, MPTokenIssuanceID: V.mptId, Flags: 1,
}, m3))
// 35 : réconciliation holderMap
{
  const v = await vinfo()
  const hm = await holderMap(cx.client, v)
  cx.rec('35', 'holderMap vs OutstandingAmount', 'rejeu account_tx',
    hm.reconciles ? `réconcilié (${hm.count} porteurs, ${hm.total} parts)` : `ÉCART: somme=${hm.total} outstanding=${hm.outstanding}`,
    hm.reconciles ? 'attendu' : 'bug probable')
}
// 38 : m3 vide son solde, ferme l'objet, holderMap le voit-il disparaître ?
{
  const sb = await shareBalance(cx.client, m3.classicAddress, V.mptId)
  await submit(cx.client, withdrawTx(m3, V.vaultId, V.mptId, sb.amount), m3)
  const gone = await shareBalance(cx.client, m3.classicAddress, V.mptId)
  cx.note('38', `m3 après retrait total: objet MPToken ${gone.holds ? 'présent (solde ' + gone.amount + ')' : 'déjà supprimé'}`)
  if (gone.holds) {
    cx.rec('38.close', 'tfMPTUnauthorize à solde nul (fermeture)', '', await submit(cx.client, {
      TransactionType: 'MPTokenAuthorize', Account: m3.classicAddress, MPTokenIssuanceID: V.mptId, Flags: 1,
    }, m3))
  }
  const hm = await holderMap(cx.client, await vinfo())
  cx.rec('38', 'holderMap après fermeture du MPToken de m3', '',
    hm.reconciles ? `réconcilié (${hm.count} porteurs)` : `ÉCART somme=${hm.total} vs ${hm.outstanding}`,
    hm.reconciles ? 'attendu' : 'bug probable',
    `porteurs: ${hm.holders.map(h => h.account.slice(0, 8) + ':' + h.shares).join(' ')}`)
}

await cx.done()
