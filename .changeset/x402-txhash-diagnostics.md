---
"@routedock/routedock": patch
---

`X402Client.pay` now reports `txHash: null` when a settled response carries an
empty or undecodable `X-Payment-Response`, instead of passing an empty string
through as if it were a transaction hash. Each of those cases, plus the unpaid
probe status, the paid request and the free (non-402) path, is emitted at debug
level through the client logger, so a failed settlement is diagnosable from the
SDK's own output.
