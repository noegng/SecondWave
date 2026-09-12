/**
 * probes-marche/06 — les 6 frictions `client libraries` tiennent-elles en beta.1 ?
 *
 *   node probes-marche/06-revalidation-beta1.mjs
 *
 * La beta.1 a corrigé la co-signature LoanSet. On vérifie une par une les cinq
 * autres frictions SDK du rapport, pour ne rien remonter qui soit déjà réglé.
 */
import { Client, Wallet, BatchFlags, signMultiBatch, validate } from 'xrpl'
import { encode, encodeForSigning } from 'ripple-binary-codec'
import { sign as kpSign } from 'ripple-keypairs'
import { connect, sleep } from '@secondwave/core'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)

const V = require('xrpl/package.json').version
console.log(`xrpl.js ${V}\n`)

const etat = []
const note = (n, titre, mesure, verdict) => etat.push({ n, titre, mesure, verdict })

// ── 1 · co-signature LoanSet ─────────────────────────────────
{
  const src = require('fs').readFileSync(
    require.resolve('xrpl/dist/npm/Wallet/utils.js'), 'utf8')
  const cable = src.includes('encodeForSigningCounterparty')
    && src.includes('encodeForMultisigningCounterparty')
  console.log(`1 · co-signature LoanSet`)
  console.log(`    encodeurs counterparty câblés : ${cable}`)
  note(1, 'signLoanSetByCounterparty', cable ? 'encodeurs CPT/CPM câblés dans SIGNING_ENCODERS' : 'toujours sur encodeForSigning',
    cable ? '✅ CORRIGÉ — vérifié aussi sur la chaîne (sonde 05)' : '❌ toujours ouvert')
}

// ── 2 · rejet local levé en exception ────────────────────────
{
  console.log(`\n2 · un rejet aux local checks : exception ou valeur ?`)
  const c = await connect()
  const w = Wallet.generate()
  const tx = {
    TransactionType: 'Payment', Account: w.classicAddress,
    Destination: Wallet.generate().classicAddress, Amount: '1000',
    Sequence: 1, Fee: '10', LastLedgerSequence: 99999999,
  }
  tx.SigningPubKey = w.publicKey
  tx.TxnSignature = kpSign(encodeForSigning(tx), w.privateKey)
  // on casse la signature APRÈS coup → refus aux local checks
  tx.TxnSignature = tx.TxnSignature.slice(0, -4) + 'DEAD'

  let forme, detail
  try {
    const r = await c.request({ command: 'submit', tx_blob: encode(tx) })
    forme = 'valeur'; detail = r.result.engine_result
  } catch (e) {
    forme = 'exception'; detail = `${e.constructor.name}: ${e.data?.error_exception ?? e.message}`
  }
  console.log(`    → ${forme} · ${detail}`)
  note(2, 'rejet local levé en exception', `${forme} — ${detail}`,
    forme === 'exception' ? '❌ toujours ouvert — un submitAndWait non protégé tombe'
                          : '✅ corrigé — rendu en valeur comme un code moteur')
  await c.disconnect()
}

// ── 3 · signMultiBatch sans Flags ────────────────────────────
{
  console.log(`\n3 · signMultiBatch sur un Batch sans champ Flags`)
  const a = Wallet.generate(), b = Wallet.generate()
  const batch = {
    TransactionType: 'Batch', Account: a.classicAddress,
    RawTransactions: [
      { RawTransaction: { TransactionType: 'AccountSet', Account: a.classicAddress,
        Sequence: 2, Fee: '0', SigningPubKey: '', Flags: 0x40000000 } },
      { RawTransaction: { TransactionType: 'AccountSet', Account: b.classicAddress,
        Sequence: 1, Fee: '0', SigningPubKey: '', Flags: 0x40000000 } },
    ],
    Sequence: 1, Fee: '150', LastLedgerSequence: 99999999,
  }
  let res
  try { signMultiBatch(b, batch); res = 'signé sans broncher' }
  catch (e) { res = `${e.constructor.name}: ${e.message}` }
  console.log(`    → ${res}`)
  const brut = res.startsWith('Error:')
  note(3, 'signMultiBatch sans Flags', res,
    brut ? '❌ toujours ouvert — Error brute, champ en minuscules, message non actionnable'
         : res.startsWith('Validation') ? '✅ amélioré — ValidationError' : 'à relire')
}

// ── 4 · LoanBrokerSet en update exige VaultID ────────────────
{
  console.log(`\n4 · LoanBrokerSet avec le seul LoanBrokerID`)
  const w = Wallet.generate()
  let res
  try {
    validate({
      TransactionType: 'LoanBrokerSet', Account: w.classicAddress,
      LoanBrokerID: 'A'.repeat(64), DebtMaximum: '1000000',
      Sequence: 1, Fee: '10', SigningPubKey: w.publicKey,
    })
    res = 'accepté'
  } catch (e) { res = `${e.constructor.name}: ${e.message}` }
  console.log(`    → ${res}`)
  note(4, 'LoanBrokerSet update sans VaultID', res,
    res === 'accepté' ? '✅ corrigé — LoanBrokerID suffit'
                      : '❌ toujours ouvert — VaultID reste exigé')
}

// ── 5 · tri des Signers en multisig de co-signature ──────────
{
  console.log(`\n5 · le SDK aide-t-il à trier les Signers ?`)
  const mod = require('xrpl/dist/npm/Wallet/utils.js')
  const aCompare = typeof mod.compareSigners === 'function'
  const src = require('fs').readFileSync(
    require.resolve('xrpl/dist/npm/Wallet/counterpartySigner.js'), 'utf8')
  const trieDansCombine = src.includes('compareSigners')
  console.log(`    compareSigners exporté                  : ${aCompare}`)
  console.log(`    combineLoanSetCounterpartySigners trie  : ${trieDansCombine}`)
  note(5, 'tri des Signers (CPM)',
    `compareSigners ${aCompare ? 'exporté' : 'absent'} · combine… ${trieDansCombine ? 'trie' : 'ne trie pas'}`,
    trieDansCombine ? '⚠️ à requalifier — le chemin officiel trie ; le piège ne concerne que le montage à la main'
                    : '❌ toujours ouvert')
}

// ── 6 · l'avertissement stdout de autofill ───────────────────
{
  console.log(`\n6 · l'avertissement de autofill sur LoanSet`)
  // ⚠️ le message vit dans sugar/autofill.js, pas dans client/ — viser le bon fichier.
  const src = require('fs').readFileSync(
    require.resolve('xrpl/dist/npm/sugar/autofill.js'), 'utf8')
  const combien = (src.match(/console\.warn\([^\n]*auto calculated Fee/g) ?? []).length
  console.log(`    console.warn « auto calculated Fee » : ${combien} occurrence(s)`)
  console.log(`    (LoanSet et transaction sponsorisée)`)
  note(6, 'avertissement autofill non désactivable',
    `${combien} console.warn dans sugar/autofill.js`,
    combien ? '❌ toujours ouvert — observé aussi à l\'exécution (sonde 05)' : '✅ corrigé')
}

// ─────────────────────────────────────────────────────────────
console.log(`\n\n════ ÉTAT DES 6 FRICTIONS SDK EN ${V} ════\n`)
for (const e of etat) {
  console.log(`  ${e.n} · ${e.titre}`)
  console.log(`      mesuré  : ${e.mesure}`)
  console.log(`      verdict : ${e.verdict}\n`)
}
const ouverts = etat.filter(e => e.verdict.startsWith('❌')).length
const corriges = etat.filter(e => e.verdict.startsWith('✅')).length
console.log(`  ${corriges} corrigée(s) · ${ouverts} encore ouverte(s) · ${etat.length - corriges - ouverts} à requalifier`)
