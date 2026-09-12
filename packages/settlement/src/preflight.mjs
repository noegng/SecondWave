/**
 * PREFLIGHT — tout ce qui peut échouer, vérifié avant de dépenser un drop.
 *
 * Le preflight n'est pas du confort : sur ce rail, `tesSUCCESS` ne prouve rien
 * (meta à un nœud, aucune jambe appliquée) et `simulate` répond `notImpl` sur
 * un `Batch`. Ce qui n'est pas attrapé ici se paie en échec silencieux.
 *
 * Trois trous mesurés, comblés ici :
 *   · l'éligibilité du VENDEUR n'était jamais vérifiée — or le gate du domaine
 *     s'applique aussi à l'émetteur d'un transfert (`tecNO_AUTH`) ;
 *   · le seuil de trésorerie était une marge forfaitaire de 2 XRP, alors que le
 *     seuil réel est `prix + base + inc × (OwnerCount + objets créés)` ;
 *   · le prix n'existait qu'en XRP — un IOU exige des trustlines des DEUX côtés
 *     et le rippling ouvert chez l'émetteur, sans quoi la jambe meurt en
 *     `tecPATH_DRY` (trois échecs silencieux d'affilée, mesurés).
 */
import {
  readVault, shareBalance, isDomainMember, SHARE_FLAGS,
} from '@secondwave/core'
import { normalizeAmount } from './amounts.mjs'
import {
  readReserve, accountFootprint, buyerSolvency, sellerSolvency, DEFAULT_RESERVE,
} from './reserve.mjs'

/** Frais portés par chaque partie, par rail — mesurés, pas estimés. */
export const RAIL_FEES = {
  batch: { seller: 200n, buyer: 0n, sellerObjects: 0, buyerObjects: 1, txCount: 1 },
  // HTLC : create + finish de chaque côté, le finish conditionnel étant majoré.
  htlc: { seller: 1_020n, buyer: 1_020n, sellerObjects: 1, buyerObjects: 2, txCount: 4 },
}

/**
 * @returns {Promise<{ok, checks, blockers, warnings, mptId, needsAuthorize, vault, price, rail}>}
 */
export async function preflight(client, {
  vaultId, seller, buyer, shares, price, rail = 'batch', reserve = null,
}) {
  const checks = [], blockers = [], warnings = []
  const ok = (name, detail) => checks.push({ name, ok: true, detail })
  const ko = (name, detail) => { checks.push({ name, ok: false, detail }); blockers.push(`${name}: ${detail}`) }
  const na = (name, detail) => { checks.push({ name, ok: null, detail }); warnings.push(`${name}: ${detail}`) }

  const fees = RAIL_FEES[rail] ?? RAIL_FEES.batch
  const v = await readVault(client, vaultId)
  const mptId = v.ShareMPTID
  const flags = Number(v.shares?.Flags ?? 0)
  const domainId = v.shares?.DomainID

  // ── 1. Les parts sont-elles cessibles du tout ? ────────────
  if (flags & SHARE_FLAGS.CAN_TRANSFER) ok('parts transférables', `flags ${flags}`)
  else ko('parts transférables', `flags ${flags} — tfVaultShareNonTransferable : ce vault n'aura jamais de marché secondaire`)

  if (rail === 'htlc') {
    if (flags & SHARE_FLAGS.CAN_ESCROW) ok('parts séquestrables', `flags ${flags} — le rail HTLC est ouvert`)
    else ko('parts séquestrables', `flags ${flags} — sans CAN_ESCROW, EscrowCreate rend tecNO_PERMISSION`)
  }

  if (flags & SHARE_FLAGS.REQUIRE_AUTH) ok('vault privé', `RequireAuth actif · domaine ${domainId?.slice(0, 12) ?? '?'}…`)
  else ok('vault public', 'aucune restriction de domaine')

  // ── 2. Les DEUX parties doivent être dans le domaine ───────
  // ⭐ Le gate vérifie l'émetteur autant que le destinataire : un vendeur exclu
  //    ne peut plus céder ses parts (tecNO_AUTH), et ne peut pas non plus les
  //    retirer pendant la phase Investment. Il est enfermé deux fois.
  const ms = await isDomainMember(client, seller, domainId)
  ms.member ? ok('vendeur éligible', ms.reason)
            : ko('vendeur éligible', `${ms.reason} — le gate refuse aussi les transferts SORTANTS`)

  const mb = await isDomainMember(client, buyer, domainId)
  mb.member ? ok('acheteur éligible', mb.reason) : ko('acheteur éligible', mb.reason)

  // ── 3. Le vendeur a-t-il les parts ? ───────────────────────
  const sb = await shareBalance(client, seller, mptId)
  if (sb.amount >= BigInt(shares)) ok('parts du vendeur', `${sb.amount} ≥ ${shares}`)
  else ko('parts du vendeur', `${sb.amount} < ${shares} — solde insuffisant `
    + '(des parts déjà bloquées en escrow sont débitées du solde MPToken)')

  // ── 4. Le prix, quel qu'en soit le numéraire ───────────────
  let amount = null
  try { amount = normalizeAmount(price) } catch (e) { ko('prix', e.message) }

  const res = reserve ?? await readReserve(client)
  const bFoot = await accountFootprint(client, buyer)
  const sFoot = await accountFootprint(client, seller)
  const bShares = await shareBalance(client, buyer, mptId)
  const needsAuthorize = !bShares.holds

  if (amount) {
    ok('numéraire', `${amount.kind} — ${amount.label}`)
    if (amount.kind === 'XRP') {
      // Le seuil exact : l'objet MPToken compte AVANT que le prix parte.
      const s = buyerSolvency({
        balance: bFoot.balance, ownerCount: bFoot.ownerCount, priceDrops: amount.drops,
        newObjects: needsAuthorize ? fees.buyerObjects : Math.max(0, fees.buyerObjects - 1),
        fees: fees.buyer, reserve: res,
      })
      s.ok ? ok('trésorerie acheteur', s.detail) : ko('trésorerie acheteur', s.detail)
    } else {
      // Prix hors XRP : l'acheteur n'a plus que réserve + frais à couvrir en XRP.
      const s = buyerSolvency({
        balance: bFoot.balance, ownerCount: bFoot.ownerCount, priceDrops: 0n,
        newObjects: needsAuthorize ? fees.buyerObjects : Math.max(0, fees.buyerObjects - 1),
        fees: fees.buyer, reserve: res,
      })
      s.ok ? ok('trésorerie acheteur (réserve)', s.detail) : ko('trésorerie acheteur (réserve)', s.detail)
      for (const c of await checkPaymentMeans(client, { payer: buyer, payee: seller, amount }))
        c.ok ? ok(c.name, c.detail) : ko(c.name, c.detail)
    }
  }

  // Le vendeur paie l'enveloppe (rail Batch) ou ses deux transactions (HTLC).
  const ss = sellerSolvency({
    balance: sFoot.balance, ownerCount: sFoot.ownerCount,
    newObjects: fees.sellerObjects, fees: fees.seller, reserve: res,
  })
  ss.ok ? ok('trésorerie vendeur', `${ss.detail} (frais ${fees.seller} drops`
    + `${fees.sellerObjects ? ` + ${fees.sellerObjects} objet(s) de réserve` : ''})`)
        : ko('trésorerie vendeur', ss.detail)

  ok('autorisation acheteur', bShares.holds
    ? 'déjà autorisé — jambe MPTokenAuthorize inutile'
    : rail === 'htlc' ? 'inutile — EscrowFinish crée l\'objet MPToken tout seul'
                      : 'à créer dans le batch (première jambe, obligatoirement)')

  // ── 5. Simulation — ce qu'on peut et ce qu'on ne peut pas ──
  // ⚠️ `simulate` renvoie notImpl sur un Batch : la transaction dont tout
  //    dépend est la seule qu'on ne puisse pas pré-jouer. On simule donc les
  //    jambes séparément, et on le DIT plutôt que de laisser croire le contraire.
  try {
    const tx_json = bShares.holds
      ? { TransactionType: 'Payment', Account: seller, Destination: buyer,
          Amount: { mpt_issuance_id: mptId, value: String(shares) } }
      : { TransactionType: 'MPTokenAuthorize', Account: buyer, MPTokenIssuanceID: mptId }
    const label = bShares.holds ? 'simulate transfert de parts' : 'simulate autorisation acheteur'
    const sim = await client.request({ command: 'simulate', tx_json })
    const r = sim.result.engine_result
    r === 'tesSUCCESS' ? ok(label, r) : ko(label, `${r} — ${sim.result.engine_result_message ?? ''}`)
  } catch (e) {
    na('simulate', `indisponible : ${e.data?.error ?? e.message}`)
  }
  if (rail === 'batch')
    na('simulate du Batch', 'impossible — rippled répond notImpl sur un Batch : '
      + 'seules les jambes ont été simulées, l\'assemblage ne l\'est pas')

  return {
    ok: blockers.length === 0, checks, blockers, warnings,
    mptId, needsAuthorize, vault: v, price: amount, rail,
    footprint: { buyer: bFoot, seller: sFoot, reserve: res },
  }
}

/**
 * Contrôles propres aux numéraires autres que l'XRP.
 * Renvoie une liste de `{ name, ok, detail }` — jamais d'exception.
 */
export async function checkPaymentMeans(client, { payer, payee, amount }) {
  const a = normalizeAmount(amount)
  const out = []
  const push = (name, ok, detail) => out.push({ name, ok, detail })

  if (a.kind === 'IOU') {
    const lines = async acct => {
      try {
        return (await client.request({ command: 'account_lines', account: acct, peer: a.issuer, ledger_index: 'validated' }))
          .result.lines.filter(l => l.currency === a.currency)
      } catch { return [] }
    }
    const want = Number(a.value)

    if (payer === a.issuer) push('trustline payeur', true, 'le payeur est l\'émetteur — il émet directement')
    else {
      const [lp] = await lines(payer)
      if (!lp) push('trustline payeur', false, `aucune trustline ${a.currency} vers ${a.issuer.slice(0, 8)}… — TrustSet requis`)
      else if (Number(lp.balance) < want)
        push('solde payeur', false, `${lp.balance} ${a.currency} < ${a.value} demandés`)
      else if (lp.freeze_peer) push('gel', false, `l'émetteur a gelé la trustline du payeur — paiement impossible`)
      else push('trustline payeur', true, `${lp.balance} ${a.currency} disponibles`)
    }

    if (payee === a.issuer) push('trustline bénéficiaire', true, 'le bénéficiaire est l\'émetteur — rachat direct')
    else {
      const [lb] = await lines(payee)
      if (!lb) push('trustline bénéficiaire', false,
        `le vendeur n'a pas de trustline ${a.currency} vers ${a.issuer.slice(0, 8)}… — il ne peut pas recevoir le prix`)
      else if (Number(lb.limit) < Number(lb.balance) + want)
        push('limite bénéficiaire', false, `limite ${lb.limit} dépassée par ${lb.balance} + ${a.value}`)
      else if (lb.freeze_peer) push('gel', false, 'l\'émetteur a gelé la trustline du bénéficiaire')
      else push('trustline bénéficiaire', true, `limite ${lb.limit}, solde ${lb.balance}`)
    }

    // ⭐ Le rippling : sans lui, tecPATH_DRY — et dans un Batch, tesSUCCESS muet.
    if (payer !== a.issuer && payee !== a.issuer) {
      const [lp] = await lines(payer), [lb] = await lines(payee)
      const bloque = [
        lp?.no_ripple_peer ? 'côté payeur' : null,
        lb?.no_ripple_peer ? 'côté bénéficiaire' : null,
      ].filter(Boolean)
      if (bloque.length)
        push('rippling chez l\'émetteur', false,
          `NoRipple posé par l'émetteur ${bloque.join(' et ')} — le paiement mourra en tecPATH_DRY. `
          + 'Correctif : l\'émetteur envoie un TrustSet tfClearNoRipple sur CHAQUE ligne '
          + '(asfDefaultRipple ne rattrape pas les lignes déjà ouvertes).')
      else if (lp && lb) push('rippling chez l\'émetteur', true, 'ouvert des deux côtés')
    }
  }

  if (a.kind === 'MPT') {
    try {
      const iss = (await client.request({ command: 'ledger_entry', mpt_issuance: a.mptId, ledger_index: 'validated' })).result.node
      const f = Number(iss?.Flags ?? 0)
      if (payer === iss?.Issuer || (f & SHARE_FLAGS.CAN_TRANSFER))
        push('MPT transférable', true, `flags ${f}`)
      else
        push('MPT transférable', false, `flags ${f} — sans CAN_TRANSFER ce jeton ne circule pas entre tiers`)
    } catch (e) {
      push('issuance du prix', false, `introuvable : ${a.mptId} (${e.data?.error ?? e.message})`)
    }
    const bal = await shareBalance(client, payer, a.mptId)
    bal.amount >= BigInt(a.value)
      ? push('solde payeur (MPT)', true, `${bal.amount} ≥ ${a.value}`)
      : push('solde payeur (MPT)', false, `${bal.amount} < ${a.value}`)
    const dst = await shareBalance(client, payee, a.mptId)
    dst.holds
      ? push('autorisation bénéficiaire (MPT)', true, 'objet MPToken présent')
      : push('autorisation bénéficiaire (MPT)', false,
        'le vendeur n\'a pas d\'objet MPToken pour ce jeton — il doit envoyer MPTokenAuthorize avant de pouvoir être payé')
  }

  return out
}
