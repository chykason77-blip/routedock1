/**
 * Web-standard binary/text codecs that run in any JavaScript runtime —
 * Cloudflare Workers (without `nodejs_compat`), Bun, Deno, browsers and Node.
 *
 * The Node-only `Buffer` global is unavailable on edge runtimes without a
 * polyfill, so everything reachable from the runtime-neutral entry points
 * (`client`, `react`, `provider/hono`) must use these helpers instead of
 * `Buffer.from(...)`. `scripts/check-runtime-neutral.mjs` enforces this in CI.
 */

const encoder = new TextEncoder()
const decoder = new TextDecoder()

/** Encode text as UTF-8 bytes. */
export function utf8ToBytes(text: string): Uint8Array {
  return encoder.encode(text)
}

/** Decode UTF-8 bytes to text. */
export function bytesToUtf8(bytes: Uint8Array): string {
  return decoder.decode(bytes)
}

/** Encode bytes as standard (padded) base64. */
export function bytesToBase64(bytes: Uint8Array): string {
  // Build the binary string in chunks so large inputs do not blow the call stack.
  const chunk = 0x8000
  let binary = ''
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(binary)
}

/**
 * Decode base64 to bytes with the same leniency as Node's
 * `Buffer.from(x, 'base64')`: URL-safe characters are accepted, padding is
 * optional, characters outside the alphabet are skipped and decoding stops at
 * the first `=`. Keeping this behaviour makes the switch away from `Buffer`
 * a no-op for every existing caller.
 */
export function base64ToBytes(b64: string): Uint8Array {
  const end = b64.indexOf('=')
  let clean = (end === -1 ? b64 : b64.slice(0, end))
    .replace(/-/g, '+')
    .replace(/_/g, '/')
    .replace(/[^A-Za-z0-9+/]/g, '')
  // A single trailing sextet carries no full byte; Buffer drops it.
  if (clean.length % 4 === 1) clean = clean.slice(0, -1)
  const binary = atob(clean)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}

/** Encode text as UTF-8 and then as base64. */
export function utf8ToBase64(text: string): string {
  return bytesToBase64(utf8ToBytes(text))
}

/**
 * Decode a base64 string to its UTF-8 text. Uses `atob` + `TextDecoder`
 * (both Web-standard) so multi-byte UTF-8 is preserved correctly — `atob`
 * alone yields a binary (latin1) string and corrupts non-ASCII bytes.
 */
export function base64ToUtf8(b64: string): string {
  return bytesToUtf8(base64ToBytes(b64))
}

/**
 * Decode a hex string to a `Uint8Array`. Accepts an optional `0x` prefix.
 * Mirrors `Buffer.from(hex, 'hex')` but returns a plain `Uint8Array`.
 */
export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex
  if (clean.length % 2 !== 0) {
    throw new Error('hexToBytes: hex string must have an even length')
  }
  const bytes = new Uint8Array(clean.length / 2)
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16)
  }
  return bytes
}

/** Encode bytes as lowercase hex. */
export function bytesToHex(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i]!.toString(16).padStart(2, '0')
  }
  return out
}
