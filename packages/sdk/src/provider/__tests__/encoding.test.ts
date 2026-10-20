import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  base64ToBytes,
  base64ToUtf8,
  bytesToBase64,
  bytesToHex,
  bytesToUtf8,
  hexToBytes,
  utf8ToBase64,
  utf8ToBytes,
} from '../encoding.js'

describe('base64ToUtf8', () => {
  it('decodes ASCII base64 to text', () => {
    const b64 = Buffer.from('hello world', 'utf8').toString('base64')
    assert.equal(base64ToUtf8(b64), 'hello world')
  })

  it('preserves multi-byte UTF-8 (matches Buffer)', () => {
    const original = 'héllo, 世界 — 🚀'
    const b64 = Buffer.from(original, 'utf8').toString('base64')
    assert.equal(base64ToUtf8(b64), original)
  })

  it('round-trips a JSON receipt payload', () => {
    const payload = JSON.stringify({ reference: 'abc123', amount: '0.0008' })
    const b64 = Buffer.from(payload, 'utf8').toString('base64')
    assert.deepEqual(JSON.parse(base64ToUtf8(b64)), JSON.parse(payload))
  })
})

describe('hexToBytes', () => {
  it('decodes a hex string to bytes (matches Buffer)', () => {
    const hex = 'deadbeef00ff'
    assert.deepEqual([...hexToBytes(hex)], [...Buffer.from(hex, 'hex')])
  })

  it('accepts a 0x prefix', () => {
    assert.deepEqual([...hexToBytes('0xdeadbeef')], [0xde, 0xad, 0xbe, 0xef])
  })

  it('returns a Uint8Array', () => {
    assert.ok(hexToBytes('00') instanceof Uint8Array)
  })

  it('throws on odd-length input', () => {
    assert.throws(() => hexToBytes('abc'), /even length/)
  })

  it('round-trips a 64-byte ed25519-style signature', () => {
    const bytes = new Uint8Array(64).map((_, i) => i)
    const hex = Buffer.from(bytes).toString('hex')
    assert.deepEqual([...hexToBytes(hex)], [...bytes])
  })
})

describe('bytes/base64/utf8 round trips (match Buffer)', () => {
  it('bytesToBase64 matches Buffer for all byte values and large inputs', () => {
    for (const len of [0, 1, 2, 3, 255, 256, 70_000]) {
      const bytes = Uint8Array.from({ length: len }, (_, i) => (i * 31) % 256)
      assert.equal(bytesToBase64(bytes), Buffer.from(bytes).toString('base64'))
      assert.deepEqual([...base64ToBytes(bytesToBase64(bytes))], [...bytes])
    }
  })

  it('utf8ToBase64 / utf8ToBytes / bytesToUtf8 preserve multi-byte text', () => {
    const text = 'héllo, 世界 — 🚀'
    assert.equal(utf8ToBase64(text), Buffer.from(text, 'utf8').toString('base64'))
    assert.deepEqual([...utf8ToBytes(text)], [...Buffer.from(text, 'utf8')])
    assert.equal(bytesToUtf8(utf8ToBytes(text)), text)
  })

  it('bytesToHex matches Buffer and round-trips hexToBytes', () => {
    const bytes = Uint8Array.from([0, 1, 15, 16, 127, 128, 255])
    assert.equal(bytesToHex(bytes), Buffer.from(bytes).toString('hex'))
    assert.deepEqual([...hexToBytes(bytesToHex(bytes))], [...bytes])
  })

  it('base64ToBytes is as lenient as Buffer (url-safe, no padding, stray characters)', () => {
    const samples = ['test-entry', 'AAECAw', 'AAECAw==', '-_-_', 'ab cd\nef', 'a', 'abcde', '', 'QQ==QQ==']
    for (const sample of samples) {
      assert.deepEqual([...base64ToBytes(sample)], [...Buffer.from(sample, 'base64')], sample)
    }
  })

  it('base64ToBytes agrees with Buffer on random inputs', () => {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/-_= !'
    let seed = 12345
    const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff
    for (let n = 0; n < 500; n++) {
      const len = Math.floor(rand() * 40)
      let sample = ''
      for (let i = 0; i < len; i++) sample += alphabet[Math.floor(rand() * alphabet.length)]
      assert.deepEqual([...base64ToBytes(sample)], [...Buffer.from(sample, 'base64')], JSON.stringify(sample))
    }
  })
})
