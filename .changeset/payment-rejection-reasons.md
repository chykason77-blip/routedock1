---
'@routedock/routedock': minor
---

Make rejected x402 payments diagnosable. The Hono, Express and Fastify providers now answer a failed payment verification with `402` plus a fresh `X-Payment-Requirements` header and the facilitator's `reason` (previously `401` with no requirements), matching the settlement-failure response. `X402Client` and `MppChargeClient` now throw a new `RouteDockPaymentRejectedError` (`code: 'PAYMENT_REJECTED'`, with `status` and the provider's `reason`) when the paid request is refused with a 4xx, instead of a `RouteDockManifestError`. `RouteDockManifestError` is kept for real manifest problems.
