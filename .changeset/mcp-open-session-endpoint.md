---
"@routedock/mcp-server": patch
---

`open_session` now resolves a bare provider origin to the streaming endpoint published in the provider's manifest (`endpoints.stream`, or the only endpoint), instead of sending vouchers and the closing `DELETE` to the origin itself, where they were paid for and then returned HTTP 404. The resolved URL must be `GET` and on the same origin. If none qualifies, the call fails without opening a session and lists the manifest's endpoints. The success payload now includes `endpoint_url`, and the `url` schema description and docs ask for the full streaming endpoint.
