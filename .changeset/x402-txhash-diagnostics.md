---
"@routedock/routedock": patch
---

`X402Client.pay` now reads the provider's `X-Payment-Response` through the same
settle-result check the provider adapters use, so a settle that reported
`success: false`, or carried an empty transaction hash, yields `txHash: null`
instead of passing an empty string through as if it were a transaction hash. The
unpaid probe status, the paid request, the free non-402 path and every header
outcome are emitted at debug level through the client logger, with the
facilitator's `errorReason` when the settle failed.
