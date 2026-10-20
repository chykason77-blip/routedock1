---
"@routedock/routedock": minor
---

`requestRefund()` and `settleWithLatestVoucher()` now wait for on-chain confirmation and return the hash only on SUCCESS. They reject with `RouteDockDisputeError` on FAILED, TRY_AGAIN_LATER or a confirmation timeout, and accept optional `{ timeoutMs, intervalMs }`.
