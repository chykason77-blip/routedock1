---
"@routedock/routedock": minor
---

Scope settlement idempotency to the resource and bound replays. `paymentIdempotencyKey` now takes a `{ method, path, amount, payTo }` scope and hashes it with the payment header, so a payment settled for one route can never replay against another route even when one store is shared. `SeenTxStore` gains a required `claimReplay(key)` method and `SettlementRecord` gains a required `createdAt`; the x402 and mpp-charge handlers now go through `checkSettlementReplay`, which replays a cached response at most `MAX_SETTLEMENT_REPLAYS` (1) times within `SETTLEMENT_REPLAY_WINDOW_MS` (60s) and responds 402 `Payment already used` beyond that. Custom `SeenTxStore` implementations must add `claimReplay`; the Supabase implementation calls the new `claim_settlement_replay` function from `supabase/migrations/005_settlement_replay_limit.sql`.
