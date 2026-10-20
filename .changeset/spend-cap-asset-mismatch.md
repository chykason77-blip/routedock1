---
"@routedock/routedock": minor
---

The local spend cap now fails closed on non-USDC assets. When `spendCap` is configured and the selected payment asset is not `spendCap.asset`, `pay()` and `openSession()` throw `RouteDockPolicyRejectError('local_cap_asset_mismatch')` before any trustline check, payment or channel deposit, instead of counting the amount as USDC. USDC-only manifests are unchanged.
