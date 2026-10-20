# Migration: runtime-neutral SDK entry points (`@routedock/routedock` 0.4)

`/client`, `/react` and `/provider/hono` no longer depend on `node:fs`, `node:crypto` or `Buffer`,
so they run in browsers and on Workers/Deno/Bun without `nodejs_compat` or polyfills.

## `FileSpendStore` moved to a Node-only entry point

`FileSpendStore` uses `node:fs`, so it is no longer re-exported from `SpendStore` or from
`@routedock/routedock/client`.

```diff
-import { RouteDockClient, FileSpendStore } from '@routedock/routedock/client'
+import { RouteDockClient } from '@routedock/routedock/client'
+import { FileSpendStore } from '@routedock/routedock/node'
```

The root entry `@routedock/routedock` still exports it, so existing root imports keep working.
`agent/` and `packages/mcp-server` now import from `@routedock/routedock/node`.

## Other changes

- `manifestDigest()` returns a `Uint8Array` instead of a `Buffer` (a `Buffer` is a `Uint8Array`, so
  only callers that used Buffer methods such as `.toString('hex')` need to change; use
  `Buffer.from(digest).toString('hex')` on Node). Digests and manifest signatures are byte-identical
  to previous releases (covered by a fixed-vector test).
- `SessionReconciler`'s `channelClose` receives `signature` as a `Uint8Array` (matches
  `@stellar/mpp`'s `close()` type).
- SHA-256/512 now come from `@noble/hashes` (already in the lockfile via the Stellar SDK).
- CI runs `scripts/check-runtime-neutral.mjs` and fails if a built runtime-neutral entry imports a
  Node built-in or references `Buffer`.

---

# Migration: apps/web Vercel → Cloudflare Workers (2026-08-02)

The **`apps/web`** Next.js app (the RouteDock site + dashboard) was moved off Vercel (Hobby account
soft-blocked for exceeding function-invocation fair-use limits) onto **Cloudflare Workers** via the
**OpenNext** adapter. It's dynamic (SSR / `force-dynamic` home page pulling live provider data), so
it runs as a real Worker — requires the **Workers Paid ($5/mo)** plan.

Scope: only `apps/web`. The `agent/`, `packages/`, and `contracts/` workspaces are unaffected.

## Changes made
| File | Change | Why |
|------|--------|-----|
| `apps/web/open-next.config.ts` | New | OpenNext Cloudflare adapter config. |
| `apps/web/wrangler.jsonc` | New | Workers config: `main: .open-next/worker.js`, `nodejs_compat`, assets binding. All 6 public `NEXT_PUBLIC_*` vars live here. |
| `apps/web/components/landing/HeroCodeBlock.tsx` | Stopped calling Shiki at runtime; now renders a **pre-highlighted** HTML constant | Cloudflare Workers disallow runtime WASM (Shiki's Oniguruma engine) and Shiki's hast serializer deps don't bundle under pnpm. |
| `apps/web/components/landing/heroCodeHtml.ts` | New — pre-generated highlighted HTML | Output of `scripts/gen-hero-code.mjs`. |
| `apps/web/scripts/gen-hero-code.mjs` | New — regenerates the hero HTML with Shiki (run in Node) | So the snippet can be re-highlighted if the code changes. |
| `apps/web/app/opengraph-image.tsx` | **Deleted** | `@vercel/og` also needs runtime WASM (blocked on Workers). |
| `apps/web/package.json` | Added `@opennextjs/cloudflare` + `wrangler` devDeps, `deploy`/`preview`/`gen:hero` scripts | Reproducible deploys. |

## Env
All 6 vars are public `NEXT_PUBLIC_*` (Supabase URL/anon, Stellar network/expert URL, provider A/B URLs)
— no secrets. Pulled from Vercel into `apps/web/.env.production.local` (gitignored) for the build and
mirrored into `wrangler.jsonc` `vars` for runtime.

## Deploy
```bash
cd apps/web && npm run deploy      # = opennextjs-cloudflare build && deploy
```
Needs `CLOUDFLARE_API_TOKEN` in env.

- **Live (Workers subdomain):** https://routedock.timjosh507.workers.dev
- **Cloudflare Worker name:** `routedock`

## Custom domains — COMPLETE

The site and provider Workers are attached to Cloudflare custom domains:

- `routedock.xyz` and `www.routedock.xyz` → dashboard Worker
- `api-a.routedock.xyz` → provider-a Worker
- `api-b.routedock.xyz` → provider-b Worker

Deployments use `wrangler deploy`; provider secrets are supplied with
`wrangler secret bulk`, never committed to `wrangler.jsonc`.
