/**
 * Node-only entry point (`@routedock/routedock/node`).
 *
 * Everything here depends on Node built-ins (`node:fs`, `node:path`) and must
 * not be imported from browser, Cloudflare Workers or other edge code. The
 * runtime-neutral entries (`/client`, `/react`, `/provider/hono`) never reach
 * this module.
 */
export * from './store/FileSpendStore.js'
