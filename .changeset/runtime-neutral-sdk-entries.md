---
'@routedock/routedock': minor
'@routedock/nulth-sdk': patch
---

Make the `client`, `react` and `provider/hono` entry points runtime-neutral (no `node:fs`, `node:crypto` or `Buffer`). `FileSpendStore` moves to the Node-only `@routedock/routedock/node` entry point (still exported from the root entry), `manifestDigest()` now returns a `Uint8Array`, and SHA-256/512 use `@noble/hashes`. CI now checks the built bundles for Node built-ins.
