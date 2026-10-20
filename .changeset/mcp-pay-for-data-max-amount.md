---
"@routedock/mcp-server": patch
---

`pay_for_data` now rejects a missing, empty, non-string, zero, negative or non-numeric `max_amount` (for example `"$0.01"`) before contacting the provider. Previously these parsed to `NaN`, the price comparison was always false, and the payment went through with no per-request ceiling. Price and `max_amount` are now compared exactly in stroops instead of as floats.
