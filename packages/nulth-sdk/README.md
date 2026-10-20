# @routedock/nulth-sdk — Stub / Proof-of-Concept

**Status: STUB — not ready for production.**

This package provides an **insecure mock prover** (`insecureMockProof`) that computes a
SHA-512 digest as a placeholder. No real zero-knowledge proof is generated.

- The mock prover is only safe for **testnet** development.
- **`NulthClient` construction throws unless `network` is `'testnet'` and the prover
  is `'mock'`.** A missing or misspelled network (for example `'pubnet'`) and any
  other prover backend are rejected, because this package does not currently
  implement a production prover backend.
- The `mock` backend is deliberately not a cryptographic proof and must never be
  used for custody or policy enforcement.

See [Issue #143](https://github.com/winsznx/routedock/issues/143) for context.

## Paying through x402 with a Nulth account

`src/scheme.ts` carries the pieces the SDK needs to let a Nulth ZK account sign an
x402 payment:

- `NULTH_SIGNER_MARKER` — a `Symbol.for` key set on every signer from
  `createNulthSigner()`. `@routedock/routedock` uses it to pick the Nulth payment
  scheme instead of the plain ed25519 one, so no caller has to opt in.
- `nulthProofScVal` / `decodeNulthProofScVal` — the `zk-v1` envelope, a
  `scvVec` of one map with `nulth`, `version`, `proof`, `auth_digest`,
  `allowlist_commitment`, `cap_commitment`, `payee_hash`, `amount_stroops` and
  `day_bucket`. The proof and its public inputs go into
  `SorobanAddressCredentials.signature`; the allowlist and the daily cap never
  leave the agent.
- `nulthAuthorizeEntry` — the `authorizeEntry` replacement. stellar-sdk's
  default writes `scvVec([nativeToScVal({public_key, signature})])`, and for a
  `C...` contract account that path throws
  `invalid version byte. expected 48, got 16` (see
  [Issue #356](https://github.com/winsznx/routedock/issues/356)), so a Nulth
  payment can never be signed with it.

**What still is not here:** the contract side. There is no Nulth account contract
in this repository that implements `__check_auth` against these public inputs, and
no Groth16 verifier is deployed, so a proof produced by the mock prover is not
settled on-chain. Testnet builds are for developing the client path only.

