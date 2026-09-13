# Verified on-chain transactions

Every link below was **re-queried on the XRPL public Devnet** by
`tools/verify-onchain.mjs` (`npm run onchain`), which reads the hashes cited
across the repository, checks each one is validated, and records its type,
result code and ledger. Nothing here is copied by hand.

**26 transactions verified across 17 transaction types** · validated ledger at check time: `5276814` · explorer: https://devnet.xrpl.org

One representative per type is shown below; where several of the same type are
verified, the count is noted. The full set is cited inline in
[README.md](README.md) and [probes-marche/PREUVES.md](probes-marche/PREUVES.md).

### Vault

| Transaction | Role in the project | Result | On-chain proof |
|---|---|---|---|
| `VaultClawback` | Issuer seizure on an IOU vault — the analyst’s red signal | `tesSUCCESS` | [`CFE2E142336590…`](https://devnet.xrpl.org/transactions/CFE2E142336590457D07681F2FEA32BB0C0360A1F16F40FBEB8B9FF69754A9BC) |
| `VaultCreate` | Create the private closed-ended vault | `tesSUCCESS` | [`080FF8A27583F4…`](https://devnet.xrpl.org/transactions/080FF8A27583F4688B17B2686B9AFD1632A3C6E0C58C6442FCF2487FA396CCEA) |
| `VaultDeposit` | Deposit during Subscription, receive shares | `tesSUCCESS` | [`BCEB981818DCE1…`](https://devnet.xrpl.org/transactions/BCEB981818DCE10B89B58DDA56DD0B55FD697B51B95E97F2DE652970AFD6B7D7) |

### Lending

| Transaction | Role in the project | Result | On-chain proof |
|---|---|---|---|
| `LoanBrokerCoverDeposit` | Deposit first-loss capital | `tesSUCCESS` | [`B43FB261B57A1F…`](https://devnet.xrpl.org/transactions/B43FB261B57A1FBA5A24A71C820F51C81AC4080DD570E14C4A6B39B0A023336C) |
| `LoanBrokerSet` | Create the broker | `tesSUCCESS` | [`C80D0BFF4DA03A…`](https://devnet.xrpl.org/transactions/C80D0BFF4DA03A04D875BAED620F07B8D326A7FF82FC61548C6F210A121C5756) |
| `LoanDelete` | Purge a settled loan | `tesSUCCESS` | [`A53489EE42EB36…`](https://devnet.xrpl.org/transactions/A53489EE42EB36A8C0B937BD407185E040CDC48529405612E5A8FF964CDF1AE2) |
| `LoanManage` | Record an impairment or a default | `tesSUCCESS` | [`9136A3B99F87B9…`](https://devnet.xrpl.org/transactions/9136A3B99F87B9526CA57AE12DADA94A253D9F5F9AF294C143C47FE102A5FDD2) |
| `LoanPay` | Repay an instalment | `tesSUCCESS` | [`8B15F1F236CBC1…`](https://devnet.xrpl.org/transactions/8B15F1F236CBC1D32E8DD2EA5A115A2CAEF781745848B80382F16ABB8C083306) |
| `LoanSet` | Grant a loan, co-signed borrower + broker  *(+1 more verified)* | `tesSUCCESS` | [`C6287B2890BAD9…`](https://devnet.xrpl.org/transactions/C6287B2890BAD94294B1D59D1D6B38617B4E077557C222C02DB919E5AEF9CA34) |

### Identity

| Transaction | Role in the project | Result | On-chain proof |
|---|---|---|---|
| `CredentialAccept` | The subject accepts — without it the credential is worthless | `tesSUCCESS` | [`0C531E57A09C81…`](https://devnet.xrpl.org/transactions/0C531E57A09C819B2EB95B16F68EA84AFB1C87E33A4675E68B08A09D3C1C2EC3) |
| `CredentialCreate` | The KYC issuer attests an account | `tesSUCCESS` | [`649F3EFDA112CB…`](https://devnet.xrpl.org/transactions/649F3EFDA112CBA2DCF8DC25AB2619A35015808DD99CC0025CB8AD27376A9D9F) |
| `PermissionedDomainSet` | The domain listing accepted credentials | `tesSUCCESS` | [`F3562B53C2A8EA…`](https://devnet.xrpl.org/transactions/F3562B53C2A8EAE17CE33E8D6BAA063AB75C554AC9241CBBB0D8D8B59D15A4B3) |

### Settlement

| Transaction | Role in the project | Result | On-chain proof |
|---|---|---|---|
| `AccountSet` | Issuer flags — and cancelling an offer by consuming its ticket  *(+3 more verified)* | `tesSUCCESS` | [`8C7C186F3DB94E…`](https://devnet.xrpl.org/transactions/8C7C186F3DB94E565DC6059410BFEE590EC9760979F010A804E49943416BE545) |
| `Batch` | The atomic exchange — shares against price  *(+3 more verified)* | `tesSUCCESS` | [`B14E9F5A16F7EA…`](https://devnet.xrpl.org/transactions/B14E9F5A16F7EA3B81D0D00C5C1098DE78250C49141EF0653D84E061945FAC2C) |
| `Payment` | Transfer — shares (MPT) or price  *(+2 more verified)* | `tesSUCCESS` | [`323F9B643E0750…`](https://devnet.xrpl.org/transactions/323F9B643E075085A0F9290637FA24576F79FDD2654FD8AD51363471C5BED760) |
| `TrustSet` | The trustline of an IOU vault | `tesSUCCESS` | [`417E22A1F2C6DA…`](https://devnet.xrpl.org/transactions/417E22A1F2C6DA2D7AFDD974B3B91AAB839D0902C8C7974A7104FE1F7883CD86) |

### Escrow

| Transaction | Role in the project | Result | On-chain proof |
|---|---|---|---|
| `EscrowFinish` | Unlock — the domain gate is re-checked here | `tecNO_AUTH` | [`9CE88BC1790759…`](https://devnet.xrpl.org/transactions/9CE88BC1790759574090FB514C4B674B2CEDFECC8EE9E341052B3FCEADCB97FC) |

## What some of these prove

- **`VaultClawback`** — an IOU vault's issuer can seize a position. That is why the analyst raises a red flag as soon as the issuer carries `AllowTrustLineClawback`.
- **`EscrowFinish` returning `tecNO_AUTH`** — the permissioned-domain gate is re-checked *at finish*, not only at creation. This is the measurement the escrow-to-a-domain proposal rests on.
- **`Batch`** — the atomic exchange. See [`probes-marche/PREUVES.md`](probes-marche/PREUVES.md) for the A / E pair: one delivered, one did nothing, and their metadata is identical.
- **`LoanSet`** — co-signed borrower + broker, submitted through the SDK helper fixed in `xrpl.js@5.2.0-beta.1`, with no workaround.

---

*Regenerate with `npm run onchain`. A dead link will show up here rather than in front of a judge.*
