---
"@routedock/routedock": minor
---

Add an optional `preSignHook` (`RouteDockClientConfig` / `X402Client`) that runs once before an x402 payment is signed. Rejecting or throwing aborts with `RouteDockPolicyRejectError`. Off by default.
