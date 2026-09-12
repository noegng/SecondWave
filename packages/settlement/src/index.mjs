/**
 * @secondwave/settlement — la revente d'une position verrouillée.
 *
 * XLS-65 bloque `VaultWithdraw` pendant toute la phase Investment. La seule
 * sortie possible est de céder les parts elles-mêmes. Deux rails le permettent,
 * et ils ne servent pas à la même chose :
 *
 *   rail « batch »  un `Batch tfAllOrNothing` — 1 transaction, ~200 drops.
 *                   Deux parties d'accord et disponibles, réglées en un ledger.
 *
 *   rail « htlc »   deux escrows liés par la même condition — 4 transactions.
 *                   L'offre existe ON-CHAIN, avec une échéance opposable par le
 *                   ledger. C'est un engagement ferme, pas un règlement immédiat.
 *
 * Le vrai travail n'est ni l'un ni l'autre : c'est de SAVOIR si ça a marché.
 * `Batch` renvoie `tesSUCCESS` même quand aucune jambe n'a appliqué, sa meta
 * ne contient que la ponction de frais, et `simulate` répond `notImpl` dessus.
 * D'où, pour les deux rails, la même discipline :
 *
 *   1. PREFLIGHT   tout ce qui peut échouer, avant de dépenser un drop
 *   2. EVIDENCE    ce que le ledger montre vraiment des jambes
 *   3. RECONCILE   les soldes avant/après. La seule vérité.
 *
 * ⚠️ Deux fonctions s'appellent `settle` et ce n'est pas un accident :
 *      · `settle({ rail, … })`          — la façade : l'échange COMPLET
 *      · `htlc.settle({ … })`           — l'étape 4 du rail HTLC seule
 *    La première orchestre, la seconde est une brique. Voir RAILS.md.
 */
import { BatchFlags } from 'xrpl'
import { readVault, shareBalance, sleep, rippleNow, txUrl } from '@secondwave/core'
import { normalizeAmount, priceLabel } from './amounts.mjs'
import { preflight as runPreflight, RAIL_FEES } from './preflight.mjs'
import { buildSwap, innerResults, submitBatch } from './batch.mjs'
import { snapshot, reconcile } from './reconcile.mjs'
import * as htlc from './htlc.mjs'
import { planTimings, MIN_MARGIN } from './timing.mjs'

export * from './amounts.mjs'
export * from './condition.mjs'
export * from './reserve.mjs'
export * from './timing.mjs'
export { preflight as preflightSwap, checkPaymentMeans, RAIL_FEES } from './preflight.mjs'
export { snapshot, reconcile, assetBalance } from './reconcile.mjs'
export { buildSwap, innerResults, submitBatch } from './batch.mjs'
export { htlc }

export const RAILS = ['batch', 'htlc']

/**
 * ⭐ LA FAÇADE — un échange complet, quel que soit le rail.
 *
 * Même forme de résultat des deux côtés, et la réconciliation des soldes dans
 * les deux cas : c'est le protocole, pas une option.
 *
 * @returns {Promise<{ok, rail, stage, moved, evidence, cost, warning, before, after, preflight}>}
 */
export async function settle(client, {
  rail = 'batch', vaultId, sellerWallet, buyerWallet, shares, price,
  skipPreflight = false, ttl = 600, margin = MIN_MARGIN, mptId = null,
}) {
  if (!RAILS.includes(rail)) throw new RangeError(`rail inconnu : « ${rail} » (attendu ${RAILS.join(' ou ')})`)
  const seller = sellerWallet.classicAddress, buyer = buyerWallet.classicAddress
  const amount = normalizeAmount(price)

  let pre = null
  if (!skipPreflight) {
    pre = await runPreflight(client, { vaultId, seller, buyer, shares, price, rail })
    if (!pre.ok)
      return { ok: false, rail, stage: 'preflight', preflight: pre, blockers: pre.blockers,
               moved: null, evidence: null, cost: null, warning: null }
  }
  const shareMpt = mptId ?? pre?.mptId ?? (await readVault(client, vaultId)).ShareMPTID
  const before = await snapshot(client, { mptId: shareMpt, price: amount, seller, buyer })

  const run = rail === 'batch' ? runBatch : runHtlc
  const out = await run(client, {
    vaultId, sellerWallet, buyerWallet, shares, price: amount, mptId: shareMpt,
    needsAuthorize: pre ? pre.needsAuthorize : !(await shareBalance(client, buyer, shareMpt)).holds,
    ttl, margin,
  })
  if (out.stage === 'submit' || out.stage === 'validation')
    return { ...out, rail, preflight: pre, before, after: null, moved: null, cost: null }

  const after = await snapshot(client, { mptId: shareMpt, price: amount, seller, buyer })
  const rec = reconcile(before, after, { shares, price: amount })

  return {
    ok: rec.ok, rail, stage: rec.ok ? 'done' : 'silent-failure',
    moved: rec.moved, evidence: out.evidence, cost: out.cost,
    hash: out.hash ?? null, url: out.hash ? txUrl(out.hash) : null,
    before, after, preflight: pre,
    priceLabel: priceLabel(amount, shares),
    warning: rec.ok ? null
      : `${out.announced ?? 'le rail'} a annoncé un succès mais la réconciliation dit : ${rec.warning}`,
  }
}

// ─────────────────────────────────────────────────────────────
// Rail « batch »
// ─────────────────────────────────────────────────────────────
async function runBatch(client, { sellerWallet, buyerWallet, shares, price, mptId, needsAuthorize }) {
  const batch = await buildSwap(client, {
    sellerWallet, buyerWallet, mptId, shares, price, needsAuthorize,
    flags: BatchFlags.tfAllOrNothing,     // ⚠️ jamais paramétrable : les trois
  })                                      //    autres drapeaux livrent sans encaisser
  const sub = await submitBatch(client, batch)
  if (!sub.ok)
    return { ok: false, stage: sub.meta ? 'validation' : 'submit',
             engineResult: sub.engineResult, message: sub.message, hash: sub.hash }

  const evidence = await innerResults(client, {
    ledgerIndex: sub.ledgerIndex, accounts: [sellerWallet.classicAddress, buyerWallet.classicAddress],
    batchHash: sub.hash,
  })
  return {
    stage: 'settled', hash: sub.hash, announced: `le Batch (${sub.result})`,
    evidence: { kind: 'batch', batchResult: sub.result, metaNodes: sub.meta?.AffectedNodes?.length ?? 0, ...evidence },
    cost: { fees: BigInt(batch.Fee), txCount: 1, reserveLocked: needsAuthorize ? 200_000n : 0n,
            note: 'frais portés par le vendeur (enveloppe) ; la réserve MPToken est chez l\'acheteur' },
  }
}

// ─────────────────────────────────────────────────────────────
// Rail « htlc » — les quatre étapes, enchaînées
// ─────────────────────────────────────────────────────────────
async function runHtlc(client, { sellerWallet, buyerWallet, shares, price, mptId, ttl, margin }) {
  const steps = []
  const seller = sellerWallet.classicAddress, buyer = buyerWallet.classicAddress
  const t = planTimings({ now: rippleNow(), ttl, margin })

  const p = await htlc.propose(client, {
    sellerWallet, buyer, mptId, shares, ttl, margin,
  })
  steps.push(p)
  if (!p.ok) return failHtlc(steps, 'propose', p)

  const a = await htlc.accept(client, {
    buyerWallet, seller, price, condition: p.condition,
    priceCancelAfter: p.priceCancelAfter, sharesCancelAfter: p.sharesCancelAfter, margin,
  })
  steps.push(a)
  if (!a.ok) return failHtlc(steps, 'accept', a, { recover: 'le vendeur récupère ses parts par refund après CancelAfter' })

  const c = await htlc.claim(client, {
    sellerWallet, buyerEscrow: a, condition: p.condition, fulfillment: p.fulfillment,
    priceCancelAfter: p.priceCancelAfter,
  })
  steps.push(c)
  if (!c.ok) return failHtlc(steps, 'claim', c, { recover: 'les deux escrows expirent : chacun reprend son dépôt' })

  // ⭐ L'acheteur ne reçoit RIEN du vendeur : il relit le secret dans la
  //    transaction de l'étape 3. C'est ce qui rend le rail asynchrone.
  const s = await htlc.settle(client, {
    buyerWallet, sellerEscrow: p, condition: p.condition, claimHash: c.hash,
  })
  steps.push(s)

  const fees = steps.reduce((s, x) => s + (x.fee ?? 0n), 0n)
  return {
    stage: 'settled', hash: s.hash ?? c.hash, announced: 'le rail HTLC',
    evidence: {
      kind: 'htlc', condition: p.condition, secretSource: s.secretSource ?? null,
      steps: steps.map(x => ({ step: x.step, ok: x.ok, result: x.result, hash: x.hash, url: x.url })),
      timings: { sharesCancelAfter: p.sharesCancelAfter, priceCancelAfter: p.priceCancelAfter, margin: t.margin },
    },
    cost: { fees, txCount: steps.length, reserveLocked: 400_000n,
            note: '2 EscrowCreate + 2 EscrowFinish conditionnels ; 0,2 XRP de réserve par escrow, rendus au dénouement' },
  }
}

const failHtlc = (steps, at, last, extra = {}) => ({
  stage: 'settled', hash: last.hash ?? null, announced: `le rail HTLC (échec à l'étape ${at})`,
  evidence: { kind: 'htlc', failedAt: at, blockers: last.blockers ?? [last.message].filter(Boolean),
              steps: steps.map(x => ({ step: x.step, ok: x.ok, result: x.result, hash: x.hash })), ...extra },
  cost: { fees: steps.reduce((s, x) => s + (x.fee ?? 0n), 0n), txCount: steps.length,
          reserveLocked: 0n, note: 'échec en cours de route — les dépôts encore bloqués reviennent par refund' },
})

// ─────────────────────────────────────────────────────────────
// L'API historique — inchangée, `apps/cli` en dépend
// ─────────────────────────────────────────────────────────────
export class SettlementEngine {
  constructor(client) { this.c = client }

  vault(vaultId) { return readVault(this.c, vaultId) }

  /** Le preflight complet. `rail` vaut 'batch' par défaut. */
  preflight(args) { return runPreflight(this.c, args) }

  /** Les quatre étapes du rail HTLC, prises une par une. */
  get htlc() {
    const c = this.c
    return {
      propose: a => htlc.propose(c, a), accept: a => htlc.accept(c, a),
      claim: a => htlc.claim(c, a), settle: a => htlc.settle(c, a),
      refund: a => htlc.refund(c, a), stillOpen: a => htlc.escrowStillOpen(c, a),
    }
  }

  buildSwap({ vaultId, sellerWallet, buyerWallet, shares, price, mptId, needsAuthorize = true }) {
    return (async () => {
      const id = mptId ?? (await this.vault(vaultId)).ShareMPTID
      return buildSwap(this.c, { sellerWallet, buyerWallet, mptId: id, shares, price, needsAuthorize })
    })()
  }

  innerResults(args) { return innerResults(this.c, args) }

  /** L'échange sur le rail de son choix ('batch' par défaut). */
  settle(args) { return settle(this.c, args) }

  /**
   * Compat : la forme de résultat attendue par `apps/cli` et
   * `fixtures/test-settlement.mjs` — stages 'preflight' | 'done' | 'silent-failure'.
   */
  async executeSwap(args) {
    const r = await settle(this.c, { rail: 'batch', ...args })
    if (r.stage === 'preflight') return { ok: false, stage: 'preflight', preflight: r.preflight, blockers: r.blockers }
    if (r.stage === 'submit' || r.stage === 'validation')
      return { ok: false, stage: r.stage, engineResult: r.engineResult, message: r.message,
               hash: r.hash, preflight: r.preflight }
    return {
      ok: r.ok, stage: r.stage, hash: r.hash, url: r.url,
      batchResult: r.evidence?.batchResult, evidence: r.evidence,
      before: r.before, after: r.after, moved: r.moved, preflight: r.preflight,
      warning: r.ok ? null
        : `Le Batch a renvoyé ${r.evidence?.batchResult} mais aucune part n'a bougé — échec silencieux.`,
    }
  }
}

export default SettlementEngine
