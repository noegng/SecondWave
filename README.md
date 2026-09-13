# SecondWave

**A secondary market for locked vault positions, with a built-in risk analyst.**

| | |
|---|---|
| **Track** | 2 — Lending Protocol · **flavour** Loaded (Permissioned Domains + Credentials) |
| **Team** | BFT-PARIS-26 — Hugo Thomas, Noé Guenego ([@noegng](https://github.com/noegng)) |
| **Network** | XRPL public Devnet — `wss://s.devnet.rippletest.net:51233` |
| **rippled** | 3.4.0-rc5 — `LendingProtocolV1_1`, `BatchV1_1`, `fixCleanup3_4_0` enabled |
| **Libraries** | `xrpl.js@5.2.0-beta.1` · `ripple-binary-codec@2.11.0` · Node ≥ 20 |
| **Explorer** | https://devnet.xrpl.org |
| **Live** | https://second-wave-vault.vercel.app |

**Deliverables:** [`FEEDBACK_RENDU.pdf`](FEEDBACK_RENDU.pdf) (developer-feedback report, 3 pages) · [`SecondWave.pptx`](SecondWave.pptx) / [`SLIDES.html`](SLIDES.html) (8 slides) · [`probes-marche/PREUVES.md`](probes-marche/PREUVES.md) (8 verified on-chain transactions).

---

## What it does

A **closed-ended** vault locks capital. For the whole Investment phase `VaultWithdraw` answers `tecTOO_SOON`: a depositor who needs their money has no way out until `RedemptionDate`.

Worse, during that lock-in the risk can degrade **without the price moving**. `AssetsTotal` only changes when the broker declares an impairment or a default, and nothing forces them to. A loan hours past its due date and its grace period leaves the NAV perfectly intact.

Vault shares are an MPT (XLS-33), so they transfer. The exit already exists — it simply had no tooling. SecondWave provides it:

- **An order book** — a locked depositor lists their shares at a price. A buyer only sees what they can actually receive, and when an offer is out of reach, the book says *why*.
- **Atomic settlement** — shares and price move together or not at all, via a `Batch tfAllOrNothing`. On top of it: a preflight that refuses to send what will fail, a reconstruction of the per-leg execution report the protocol does not provide, and a balance reconciliation.
- **A risk analyst** — the seller always cuts the price; the question is *why*. The analyst separates a **liquidity discount** (the fund is fine, the seller needs cash — an opportunity) from a **distress discount** (the fund is sick and it does not show yet). Nothing on-chain separates them: two offers at the same price can be a bargain and a trap.

Offers are carried by **Tickets**, so a signed offer survives both parties transacting and can be cancelled on-chain for 1 drop. Without them an offer dies in 72 seconds — see section "In closing" of the report.

---

## Setup

```bash
git clone https://github.com/noegng/SecondWave && cd SecondWave
npm install
npm test                     # 116 tests, offline, no faucet
```

### Generate a test world on Devnet

```bash
npm run world                                  # ~12 min: accounts, credentials, domain, 7 vaults, loans
npm run world -- --invite rAlice --invite rBob # same, plus external wallets credentialled and able to deposit
```

Writes `world.json` (public identifiers, committed), `state.json` (**seeds — gitignored**) and `snapshot.json` (each vault's frozen state, committed).

> **The world ages.** Loan payments fall due every 120 s, so a world generated an hour ago has every loan overdue and `npm test` will flag it. Regenerate shortly before any demo. `node fixtures/resync.mjs` re-derives `world.json` / `snapshot.json` from a local `state.json` without recreating anything.

### Run it

```bash
npm run web                  # http://localhost:8787 — the order book, the ratings, settlement

npm run cli vaults           # the vaults, rated by the analyst
npm run cli offer sain 3000000 2.6   # publish a durable offer (nothing signed yet)
npm run cli take o001 sain.d1        # the buyer commits — BatchSigners, 24 h deadline
npm run cli confirm o001             # the seller confirms → Batch submitted, legs verified
npm run cli annuler o001             # the seller burns the ticket — tefNO_TICKET
npm run cli history sain             # price history, read back from the chain

npm run analyse -- predateur # rate a vault offline, no network, no faucet
npm run analyse -- scan      # sweep the ledger for every Vault object
npm run test:rails           # Batch · HTLC (two conditioned escrows) · IOU
npm run test:durable         # end-to-end durable rail on a real private vault (~4 min)
```

The web interface needs the local server: settlement signs with the seeds in `state.json`, which never leave the machine. The Vercel deployment is therefore read-only and says so.

---

## Repository layout

```
packages/core         ledger reads, submission, vault traversal, holder map
packages/vault        the XLS-65/66 lifecycle, with the undocumented rules encoded
packages/settlement   two settlement rails — Batch and HTLC — plus tickets and durable offers
packages/orderbook    the book, eligibility, coverage, price history
packages/analyst      risk rating
apps/cli              the terminal demo
apps/web              the interface and its settlement API
fixtures/             world generator, resync, integration tests
probes/               ~350 probe cases on XLS-65/66
probes-marche/        ~90 probe cases on the secondary market, plus PREUVES.md
```

---

## Standards used

| Standard | Name | What it brings |
|---|---|---|
| **XLS-65** | Single Asset Vault | the fund: deposits, shares, phases |
| **XLS-66** | Lending Protocol | loans, brokers, first-loss capital |
| **XLS-33** | Multi-Purpose Tokens | shares are an MPT — which is what makes them transferable |
| **XLS-56** | Batch | atomicity of the exchange |
| **XLS-70** | Credentials | the attestation identifying a member |
| **XLS-80** | Permissioned Domains | the closed club: only the right credential gets in |

`OfferCreate` with an MPT answers `temDISABLED` — the native order book does not accept MPTs yet, which is why ours is off-chain. Settlement itself is entirely on-chain.

---

## Every transaction used, with on-chain proof

Each link points at a real transaction on the public Devnet.

### XLS-65 — Vault

| Transaction | Role in the project | Proof |
|---|---|---|
| `VaultCreate` | create the private closed-ended vault | [`080FF8A2…`](https://devnet.xrpl.org/transactions/080FF8A27583F4688B17B2686B9AFD1632A3C6E0C58C6442FCF2487FA396CCEA) |
| `VaultSet` | update a vault's `Data` — accepted in all three phases, then silently dropped | *see `probes/campaign-b.mjs`, case 21* |
| `VaultDeposit` | deposit during Subscription, receive shares | [`BCEB9818…`](https://devnet.xrpl.org/transactions/BCEB981818DCE10B89B58DDA56DD0B55FD697B51B95E97F2DE652970AFD6B7D7) |
| `VaultWithdraw` | exit during Redemption — and **refused** during Investment, which is what founds the project | *see `probes/out/b.json`* |
| `VaultClawback` | seizure by the issuer of an IOU vault — the analyst's red signal | [`CFE2E142…`](https://devnet.xrpl.org/transactions/CFE2E142336590457D07681F2FEA32BB0C0360A1F16F40FBEB8B9FF69754A9BC) |

### XLS-66 — Lending

| Transaction | Role in the project | Proof |
|---|---|---|
| `LoanBrokerSet` | create the broker | [`C80D0BFF…`](https://devnet.xrpl.org/transactions/C80D0BFF4DA03A04D875BAED620F07B8D326A7FF82FC61548C6F210A121C5756) |
| `LoanBrokerCoverDeposit` | deposit first-loss capital | [`B43FB261…`](https://devnet.xrpl.org/transactions/B43FB261B57A1FBA5A24A71C820F51C81AC4080DD570E14C4A6B39B0A023336C) |
| `LoanBrokerCoverWithdraw` | withdraw it — 100 % possible at zero debt | *see `probes/out/e.json`* |
| `LoanSet` | grant a loan, co-signed borrower + broker | [`C6287B28…`](https://devnet.xrpl.org/transactions/C6287B2890BAD94294B1D59D1D6B38617B4E077557C222C02DB919E5AEF9CA34) |
| `LoanPay` | repay an instalment | [`8B15F1F2…`](https://devnet.xrpl.org/transactions/8B15F1F236CBC1D32E8DD2EA5A115A2CAEF781745848B80382F16ABB8C083306) |
| `LoanManage` | record an impairment or a default | [`9136A3B9…`](https://devnet.xrpl.org/transactions/9136A3B99F87B9526CA57AE12DADA94A253D9F5F9AF294C143C47FE102A5FDD2) |
| `LoanDelete` | purge a settled loan | [`A53489EE…`](https://devnet.xrpl.org/transactions/A53489EE42EB36A8C0B937BD407185E040CDC48529405612E5A8FF964CDF1AE2) |

### Identity, tokens and settlement

| Transaction | Role in the project | Proof |
|---|---|---|
| `CredentialCreate` | the KYC issuer attests an account | [`649F3EFD…`](https://devnet.xrpl.org/transactions/649F3EFDA112CBA2DCF8DC25AB2619A35015808DD99CC0025CB8AD27376A9D9F) |
| `CredentialAccept` | the subject accepts — **without it the credential is worthless** | [`0C531E57…`](https://devnet.xrpl.org/transactions/0C531E57A09C819B2EB95B16F68EA84AFB1C87E33A4675E68B08A09D3C1C2EC3) |
| `PermissionedDomainSet` | the domain listing accepted credentials | [`F3562B53…`](https://devnet.xrpl.org/transactions/F3562B53C2A8EAE17CE33E8D6BAA063AB75C554AC9241CBBB0D8D8B59D15A4B3) |
| `MPTokenAuthorize` | the buyer authorises themselves to receive the shares | *first leg of the `Batch` below* |
| `Payment` (MPT) | the share transfer | [`323F9B64…`](https://devnet.xrpl.org/transactions/323F9B643E075085A0F9290637FA24576F79FDD2654FD8AD51363471C5BED760) |
| `Batch` | **the atomic exchange** — shares against price | [`B14E9F5A…`](https://devnet.xrpl.org/transactions/B14E9F5A16F7EA3B81D0D00C5C1098DE78250C49141EF0653D84E061945FAC2C) |
| `TicketCreate` | reserve the sequence numbers that make an offer durable | *see [`PREUVES.md`](probes-marche/PREUVES.md)* |
| `EscrowCreate` / `EscrowFinish` | the HTLC rail — two escrows sharing one condition | *see `probes-marche/FRICTIONS.md`* |
| `TrustSet` | the trustline of an IOU vault | [`417E22A1…`](https://devnet.xrpl.org/transactions/417E22A1F2C6DA2D7AFDD974B3B91AAB839D0902C8C7974A7104FE1F7883CD86) |
| `AccountSet` | `DefaultRipple` and `AllowTrustLineClawback` on the IOU issuer; also **cancels an offer** by consuming its ticket | [`8C7C186F…`](https://devnet.xrpl.org/transactions/8C7C186F3DB94E565DC6059410BFEE590EC9760979F010A804E49943416BE545) |

### Transactions that each prove a point of the report

| | Proof |
|---|---|
| A `Batch` returning **`tesSUCCESS` with no leg applied** — the pair A / E, with identical metadata | [`PREUVES.md`](probes-marche/PREUVES.md) |
| A `LoanSet` submitted with the **SDK helper fixed** in `5.2.0-beta.1`, no workaround | [`929864F3…`](https://devnet.xrpl.org/transactions/929864F308A9D9A037CCF09219D9867471A1E28393B2CE95FB67429C3B5E5F8D) |
| An `EscrowFinish` refused with **`tecNO_AUTH`**: the domain gate is re-checked at finish | [`9CE88BC1…`](https://devnet.xrpl.org/transactions/9CE88BC1790759574090FB514C4B674B2CEDFECC8EE9E341052B3FCEADCB97FC) |

---

## Notes

**The order book is off-chain, out of necessity.** `OfferCreate` refuses MPTs (`temDISABLED`), and an escrow requires a `Destination` — so a bearer offer cannot be published. The report proposes letting an escrow point at a permissioned domain instead.

**The book is one-sided**: only sellers list. We verified that a `Batch` envelope can be carried by the buyer, so a two-sided book is buildable — we did not wire it.

**Settlement signs server-side**, with the seeds in `state.json`. That is a demo limitation, not a design: no wallet can sign a `Batch` today. See point 10 of the long report.

Long-form French annexes remain in [`FEEDBACK.md`](FEEDBACK.md), [`FEEDBACK_XLS65_XLS66.md`](FEEDBACK_XLS65_XLS66.md), [`FRICTIONS-annexe.md`](FRICTIONS-annexe.md) and the `probes*/FRICTIONS.md` files.
