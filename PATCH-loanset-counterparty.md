# `signLoanSetByCounterparty` produces an invalid signature

**Library:** `xrpl.js@5.2.0-beta.0` (also 5.1.0) · **Severity:** blocker · **Category:** client libraries
**Effect:** `LoanSet` cannot be submitted from the published SDK. The whole XLS-66 lending flow is unreachable.

> ## ✅ RESOLVED in `xrpl.js@5.2.0-beta.1` (12/09, mid-hackathon)
>
> The event switched the required package to `5.2.0-beta.1`, which ships exactly
> the fix proposed below: `computeSignature` now takes a `role` and a
> `SIGNING_ENCODERS` table maps `counterparty` → `encodeForSigningCounterparty`
> (`CPT\0`) / `encodeForMultisigningCounterparty` (`CPM\0`) — plus a new
> `sponsor` role. Verified in `node_modules/xrpl/dist/npm/Wallet/utils.js` and
> re-validated on-chain (`probes-marche/06-revalidation-beta1.mjs`).
>
> Still open: the CI config (`xrpld.cfg`) stops at `fixCleanup3_2_0` so the
> regression remains untestable in CI, and `xrpl-py` still carries the bug.
>
> Our `core.counterpartySign` workaround is **kept**: it calls the same codec
> encoders directly, produces byte-identical signatures under beta.0 and beta.1,
> and shields us from any further SDK churn during the event.

---

## Symptom

```
fails local checks: Counterparty: Invalid signature.
```

Reproduced with the portal's own sample `_code-samples/lending-protocol/js/createLoan.js`, and with a minimal script (below).

## Root cause

`fixCleanup3_4_0` — **active on the public Devnet** — introduced role-specific signing prefixes in `rippled`:

```cpp
// include/xrpl/protocol/HashPrefix.h
CounterpartyTxSign      = 'C','P','T'   // 0x43505400
CounterpartyTxMultiSign = 'C','P','M'   // 0x43504D00
```

`ripple-binary-codec@2.11.0` **already ships them**, with the fix named in a comment:

```js
// dist/hash-prefixes.js
// inner transaction to sign as the counterparty (fixCleanup3_4_0)
counterpartyTransactionSig:      bytes(0x43505400),
counterpartyTransactionMultiSig: bytes(0x43504d00),
```

and exports the matching encoders:

```
encodeForSigningCounterparty, encodeForMultisigningCounterparty
```

**But `signLoanSetByCounterparty` never calls them.** It uses the generic `computeSignature`, which goes through `encodeForSigning` → the historic `STX\0` prefix (`0x53545800`). The server rejects it.

> The prefixes were shipped in the codec; the helper was not wired to them.

## Why nobody noticed

`packages/xrpl/.ci-config/xrpld.cfg` **does not enable `fixCleanup3_4_0`** — it stops at `fixCleanup3_2_0` plus the 3.3.0 amendments. The helper is therefore never exercised in the regime where it breaks.

---

## Proof — same transaction, two prefixes

Devnet `s.devnet.rippletest.net`, `rippled 3.4.0-rc5`, `xrpl.js@5.2.0-beta.0`:

| Signing payload | Result |
|---|---|
| `encodeForSigning(tx)` — what the SDK does | ❌ `fails local checks: Counterparty: Invalid signature.` |
| `encodeForSigningCounterparty(tx)` | ✅ `tesSUCCESS` — `Loan` object created |

Full reproduction: `verify-fix.mjs` (creates vault → broker → cover → attempts both signatures).

---

## Proposed fix

`packages/xrpl/src/Wallet/counterpartySigner.ts` — use the counterparty encoders that already exist:

```diff
+import {
+  encode,
+  encodeForSigningCounterparty,
+  encodeForMultisigningCounterparty,
+} from 'ripple-binary-codec'
+import { sign as signWithKeypair } from 'ripple-keypairs'
+
+function computeCounterpartySignature(
+  tx: Transaction,
+  privateKey: string,
+  signAs?: string,
+): string {
+  if (signAs) {
+    const classicAddress = isValidXAddress(signAs)
+      ? xAddressToClassicAddress(signAs).classicAddress
+      : signAs
+    return signWithKeypair(
+      encodeForMultisigningCounterparty(tx, classicAddress),
+      privateKey,
+    )
+  }
+  return signWithKeypair(encodeForSigningCounterparty(tx), privateKey)
+}

 if (multisignAddress) {
   tx.CounterpartySignature = {
     Signers: [
       {
         Signer: {
           Account: multisignAddress,
           SigningPubKey: wallet.publicKey,
-          TxnSignature: computeSignature(tx, wallet.privateKey, multisignAddress),
+          TxnSignature: computeCounterpartySignature(
+            tx, wallet.privateKey, multisignAddress,
+          ),
         },
       },
     ],
   }
 } else {
   tx.CounterpartySignature = {
     SigningPubKey: wallet.publicKey,
-    TxnSignature: computeSignature(tx, wallet.privateKey),
+    TxnSignature: computeCounterpartySignature(tx, wallet.privateKey),
   }
 }
```

**Also recommended:** add `fixCleanup3_4_0` to `packages/xrpl/.ci-config/xrpld.cfg`, otherwise the regression cannot be caught in CI.

Both paths verified on Devnet: single-signature with `CPT\0`, multi-signature with `CPM\0` (2-of-2 signer list on the broker account).

---

## Same issue in `xrpl-py`

`xrpl/transaction/counterparty_signer.py` calls `encode_for_signing(tx_json)` and `encode_for_multisigning(tx_json, address)` — the same generic encoders. The Python binary codec needs the two prefixes before the equivalent fix can land.

---

## Minimal reproduction

```js
import { Client, Wallet } from 'xrpl'
import { encode, encodeForSigning, encodeForSigningCounterparty } from 'ripple-binary-codec'
import { sign as kpSign } from 'ripple-keypairs'

// … create a closed-ended vault, a LoanBroker and deposit cover, wait for the Investment phase …

const p = await client.autofill({
  TransactionType: 'LoanSet', Account: borrower.classicAddress,
  LoanBrokerID, Counterparty: broker.classicAddress,
  PrincipalRequested: '5000000', PaymentInterval: 60,
  GracePeriod: 60, PaymentTotal: 2, InterestRate: 50000,
})
p.SigningPubKey = borrower.publicKey
p.TxnSignature  = kpSign(encodeForSigning(p), borrower.privateKey)

// ❌ what signLoanSetByCounterparty does today
const bad  = kpSign(encodeForSigning(p), broker.privateKey)
// ✅ the fix
const good = kpSign(encodeForSigningCounterparty(p), broker.privateKey)

await client.request({ command: 'submit', tx_blob: encode({
  ...p, CounterpartySignature: { SigningPubKey: broker.publicKey, TxnSignature: good },
}) })
```
