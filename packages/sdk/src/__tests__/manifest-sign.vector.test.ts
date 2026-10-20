/**
 * Fixed-vector regression for runtime-neutral manifest signing (#554).
 *
 * The expected values below were produced by the previous implementation
 * (`node:crypto` SHA-256 + `Buffer` base64). Ed25519 is deterministic, so the
 * pure-JS SHA-256 / base64 path must reproduce them byte for byte, otherwise
 * manifests signed before the change would stop verifying (or vice versa).
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { describe, it } from 'node:test'
import { Keypair } from '@stellar/stellar-sdk'
import { manifestDigest, signManifest, verifyManifestSignature } from '../manifest/sign.js'
import { bytesToHex } from '../internal/encoding.js'
import { sha256Hex, sha512 } from '../internal/hash.js'
import type { RouteDockManifest } from '../types.js'

// Deterministic throwaway key derived from a fixed seed at runtime (no secret
// literal in source). It only exists to make the expected signature reproducible.
const SECRET = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 7)).secret()
const PAYEE = 'GDVEU3DD4KOFECV66VIHWEZOYX4ZKR3WV27L464SIIPOU2IUI3JCZA57'

const MANIFEST = {
  routedock: '1.0',
  name: 'Vector Provider — héllo 世界',
  description: 'Fixed vector for runtime-neutral signing',
  modes: ['x402', 'mpp-charge'],
  network: 'testnet',
  asset: 'USDC',
  asset_contract: 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA',
  payee: PAYEE,
  pricing: { x402: { amount: '0.001', per: 'request' } },
  endpoints: { price: { method: 'GET', path: '/price', headers: { b: '2', a: '1' } } },
} as unknown as RouteDockManifest

const EXPECTED_DIGEST = '84b133fa1561fa88a4a2801042a7841dedb204ea06678b3a4352266a167aa113'
const EXPECTED_SIGNATURE =
  'xPv7ymyLsUG+/EfUFPqV72hAvNimTyMGNxD/MtLiKtvh7KKFa28CJzdDzRpCTCVreWEgBWVvCDI+esGAuRvaDw=='

describe('manifest signing — fixed vector (byte-identical to the node:crypto implementation)', () => {
  it('the vector keypair matches the expected payee', () => {
    assert.equal(Keypair.fromSecret(SECRET).publicKey(), PAYEE)
  })

  it('produces the exact historical digest', () => {
    const digest = manifestDigest({ ...MANIFEST, signature_version: '2' } as RouteDockManifest)
    assert.equal(bytesToHex(digest), EXPECTED_DIGEST)
  })

  it('produces the exact historical signature', () => {
    const signed = signManifest(MANIFEST, SECRET)
    assert.equal(signed.signature, EXPECTED_SIGNATURE)
    assert.equal(signed.signature_version, '2')
  })

  it('verifies a signature produced by the previous implementation', () => {
    verifyManifestSignature(
      { ...MANIFEST, signature_version: '2', signature: EXPECTED_SIGNATURE } as RouteDockManifest & {
        signature: string
      },
      PAYEE,
    )
  })
})

describe('runtime-neutral hashing matches node:crypto', () => {
  const inputs = ['', 'abc', 'héllo 世界 🚀', 'x'.repeat(10_000)]

  it('sha256 hex', () => {
    for (const input of inputs) {
      assert.equal(sha256Hex(input), createHash('sha256').update(input, 'utf8').digest('hex'))
    }
  })

  it('sha256 over raw bytes', () => {
    const bytes = Uint8Array.from({ length: 300 }, (_, i) => i % 256)
    assert.equal(sha256Hex(bytes), createHash('sha256').update(bytes).digest('hex'))
  })

  it('sha512', () => {
    for (const input of inputs) {
      assert.equal(
        Buffer.from(sha512(input)).toString('base64'),
        createHash('sha512').update(input, 'utf8').digest('base64'),
      )
    }
  })
})
