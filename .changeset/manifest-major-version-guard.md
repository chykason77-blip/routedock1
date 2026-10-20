---
"@routedock/routedock": patch
---

Refuse a manifest whose `routedock` schema major version is newer than the SDK supports. `fetchManifest` now throws `RouteDockClientVersionError` (`CLIENT_VERSION_TOO_OLD`) for majors above 1 on both the fresh-fetch and cache-hit paths, and never caches a rejected manifest. Any minor of a supported major (`1.1`, `1.3`) keeps working, since minor bumps are additive. Previously a 1.x client read a `2.0` or `9.0` manifest with 1.x field meanings and routed payments on it, unless the provider also happened to set `min_client_version`.
