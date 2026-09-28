import assert from 'node:assert/strict'
import { describe, it, after } from 'node:test'
import { createServer, type Server } from 'node:http'
import Fastify from 'fastify'
import { Keypair } from '@stellar/stellar-sdk'
import { routedockFastify } from '../fastify.js'
import type { RouteDockManifest } from '../../types.js'
import { InMemorySeenTxStore, paymentIdempotencyKey } from '../SeenTxStore.js'
import { usdcToStroops } from '../../internal/usdc.js'

// Generate fresh keypairs — avoids hardcoding secrets while keeping tests self-contained
const payeeKeypair = Keypair.random()
const commitKeypair = Keypair.random()

const ASSET_CONTRACT = 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA'
const CHANNEL_CONTRACT = 'CCK4XOW3YKQUEZFONUTINKMSNW7SNMRQZURME5U3UP7E6WNGK7UHUCAH'

const manifest: RouteDockManifest = {
  routedock: '1.0',
  name: 'Fastify Test Service',
  description: 'Unit test provider for Fastify adapter',
  modes: ['x402', 'mpp-charge', 'mpp-session'],
  network: 'testnet',
  asset: 'USDC',
  asset_contract: ASSET_CONTRACT,
  payee: payeeKeypair.publicKey(),
  pricing: {
    x402: { amount: '0.001', per: 'request' },
    'mpp-charge': { amount: '0.0008', per: 'request' },
    'mpp-session': {
      rate: '0.0001',
      per: 'voucher',
      channel_factory: CHANNEL_CONTRACT,
      min_deposit: '0.10',
      refund_waiting_period_ledgers: 17280,
    },
  },
  endpoints: { price: { method: 'GET', path: '/price' } },
  tags: ['test'],
}

const BASE_OPTS = {
  asset: 'USDC',
  assetContract: ASSET_CONTRACT,
  payee: payeeKeypair.publicKey(),
  network: 'testnet' as const,
  payeeSecretKey: payeeKeypair.secret(),
  commitmentPublicKey: commitKeypair.publicKey(),
  manifest,
}

/** Spin up a Fastify instance, return its base URL and a close function. */
async function makeServer(
  overrides: Partial<typeof BASE_OPTS & {
    modes: ('x402' | 'mpp-charge' | 'mpp-session')[]
    pricing: Record<string, unknown>
  }> = {},
): Promise<{ url: string; close: () => Promise<void> }> {
  const fastify = Fastify()
  await fastify.register(
    routedockFastify({
      ...BASE_OPTS,
      modes: ['x402', 'mpp-charge', 'mpp-session'],
      pricing: {
        x402: '0.001',
        'mpp-charge': '0.0008',
        'mpp-session': { rate: '0.0001', channelFactory: CHANNEL_CONTRACT },
      },
      ...overrides,
    } as Parameters<typeof routedockFastify>[0]),
  )

  fastify.get('/price', async () => ({ price: '42' }))

  await fastify.listen({ port: 0, host: '127.0.0.1' })
  const address = fastify.server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => fastify.close(),
  }
}

describe('routedockFastify — manifest endpoint', () => {
  it('serves a signed /.well-known/routedock.json', async () => {
    const { url, close } = await makeServer({ modes: [] as ('x402' | 'mpp-charge' | 'mpp-session')[], pricing: {} })
    try {
      const res = await fetch(`${url}/.well-known/routedock.json`)
      assert.equal(res.status, 200)
      const body = await res.json() as { name: string; signature: string }
      assert.equal(body.name, manifest.name, 'manifest name should match')
      assert.ok(body.signature, 'manifest should be signed (signature field present)')
    } finally {
      await close()
    }
  })

  it('passes through to route handler when no modes are configured', async () => {
    const { url, close } = await makeServer({ modes: [], pricing: {} })
    try {
      const res = await fetch(`${url}/price`)
      assert.equal(res.status, 200)
      const body = await res.json() as { price: string }
      assert.equal(body.price, '42')
    } finally {
      await close()
    }
  })
})

describe('routedockFastify — x402 flow', () => {
  it('returns 402 with X-Payment-Requirements when no payment header', async () => {
    const { url, close } = await makeServer({ modes: ['x402'], pricing: { x402: '0.001' } })
    try {
      const res = await fetch(`${url}/price`)
      assert.equal(res.status, 402)
      assert.ok(
        res.headers.get('x-payment-requirements'),
        'expected X-Payment-Requirements header on 402',
      )
      const body = await res.json() as { error: string }
      assert.equal(body.error, 'Payment Required')
    } finally {
      await close()
    }
  })

  it('routes to x402 handler when x-preferred-mode: x402 header is set', async () => {
    const { url, close } = await makeServer({
      modes: ['x402', 'mpp-charge'],
      pricing: { x402: '0.001', 'mpp-charge': '0.0008' },
    })
    try {
      const res = await fetch(`${url}/price`, {
        headers: { 'x-preferred-mode': 'x402' },
      })
      // Without a valid x402 payment header, still 402
      assert.equal(res.status, 402)
      assert.ok(res.headers.get('x-payment-requirements'), 'x402 handler should set X-Payment-Requirements')
    } finally {
      await close()
    }
  })
})

describe('routedockFastify — mpp-charge flow', () => {
  it('returns 402 challenge when no authorization header', async () => {
    const { url, close } = await makeServer({ modes: ['mpp-charge'], pricing: { 'mpp-charge': '0.0008' } })
    try {
      const res = await fetch(`${url}/price`)
      assert.equal(res.status, 402)
    } finally {
      await close()
    }
  })
})

describe('routedockFastify — mpp-session flow', () => {
  it('returns 402 challenge when no authorization header', async () => {
    const { url, close } = await makeServer({ modes: ['mpp-session'], pricing: { 'mpp-session': { rate: '0.0001', channelFactory: CHANNEL_CONTRACT } } })
    try {
      const res = await fetch(`${url}/price`)
      assert.equal(res.status, 402)
    } finally {
      await close()
    }
  })

  it('returns { closeTxHash: null } on DELETE with no prior vouchers', async () => {
    const { url, close } = await makeServer({ modes: ['mpp-session'], pricing: { 'mpp-session': { rate: '0.0001', channelFactory: CHANNEL_CONTRACT } } })
    try {
      const res = await fetch(`${url}/price`, { method: 'DELETE' })
      assert.equal(res.status, 200)
      const body = await res.json() as { closeTxHash: null }
      assert.equal(body.closeTxHash, null)
    } finally {
      await close()
    }
  })
})

describe('routedockFastify — settlement idempotency', () => {
  const X402_AMOUNT = String(usdcToStroops('0.001'))

  /** Fastify server with a counted /price route sharing a caller-supplied store. */
  async function makeCountedServer(seenTxStore: InMemorySeenTxStore) {
    const fastify = Fastify()
    let runs = 0
    await fastify.register(
      routedockFastify({
        ...BASE_OPTS,
        modes: ['x402'],
        pricing: { x402: '0.001' },
        seenTxStore,
      } as Parameters<typeof routedockFastify>[0]),
    )
    fastify.get('/price', async () => {
      runs++
      return { price: '42' }
    })
    await fastify.listen({ port: 0, host: '127.0.0.1' })
    const address = fastify.server.address()
    const port = typeof address === 'object' && address ? address.port : 0
    return {
      url: `http://127.0.0.1:${port}`,
      runs: () => runs,
      close: () => fastify.close(),
    }
  }

  it('replays a fresh settlement and rejects the second replay', async () => {
    const seenStore = new InMemorySeenTxStore({ warn: false })
    const server = await makeCountedServer(seenStore)
    try {
      const key = await paymentIdempotencyKey(
        (n) => (n === 'payment-signature' ? 'SIG' : undefined),
        { method: 'GET', path: '/price', amount: X402_AMOUNT, payTo: payeeKeypair.publicKey() },
      )
      assert.ok(key)
      await seenStore.set(key, {
        txHash: 'TX',
        headers: { 'X-Payment-Response': 'cached-response' },
        createdAt: Date.now(),
      })

      const first = await fetch(`${server.url}/price`, { headers: { 'payment-signature': 'SIG' } })
      assert.equal(first.status, 200)
      assert.equal(first.headers.get('x-payment-response'), 'cached-response')
      assert.equal(server.runs(), 1)

      const second = await fetch(`${server.url}/price`, { headers: { 'payment-signature': 'SIG' } })
      assert.equal(second.status, 402)
      const body = (await second.json()) as { error: string }
      assert.equal(body.error, 'Payment already used')
      assert.equal(server.runs(), 1)
    } finally {
      await server.close()
    }
  })

  it('rejects a settlement older than the replay window', async () => {
    const seenStore = new InMemorySeenTxStore({ warn: false })
    const server = await makeCountedServer(seenStore)
    try {
      const key = await paymentIdempotencyKey(
        (n) => (n === 'payment-signature' ? 'SIG' : undefined),
        { method: 'GET', path: '/price', amount: X402_AMOUNT, payTo: payeeKeypair.publicKey() },
      )
      assert.ok(key)
      await seenStore.set(key, { txHash: 'TX', createdAt: Date.now() - 61_000 })

      const res = await fetch(`${server.url}/price`, { headers: { 'payment-signature': 'SIG' } })
      assert.equal(res.status, 402)
      assert.equal(server.runs(), 0)
    } finally {
      await server.close()
    }
  })

  it('does not replay a payment settled on a different route against a shared store', async () => {
    const seenStore = new InMemorySeenTxStore({ warn: false })
    const fastify = Fastify()
    let cheapRuns = 0
    let expensiveRuns = 0
    await fastify.register(
      routedockFastify({
        ...BASE_OPTS,
        modes: ['x402'],
        pricing: { x402: '0.001' },
        seenTxStore: seenStore,
      } as Parameters<typeof routedockFastify>[0]),
    )
    fastify.get('/cheap', async () => { cheapRuns++; return { price: 'cheap' } })
    fastify.get('/expensive', async () => { expensiveRuns++; return { price: 'expensive' } })
    await fastify.listen({ port: 0, host: '127.0.0.1' })
    const address = fastify.server.address()
    const port = typeof address === 'object' && address ? address.port : 0
    const url = `http://127.0.0.1:${port}`
    try {
      const cheapKey = await paymentIdempotencyKey(
        (n) => (n === 'payment-signature' ? 'SIG' : undefined),
        { method: 'GET', path: '/cheap', amount: X402_AMOUNT, payTo: payeeKeypair.publicKey() },
      )
      assert.ok(cheapKey)
      await seenStore.set(cheapKey, { txHash: 'TX', createdAt: Date.now() })

      const cheapRes = await fetch(`${url}/cheap`, { headers: { 'payment-signature': 'SIG' } })
      assert.equal(cheapRes.status, 200)
      assert.equal(cheapRuns, 1)

      const expensiveRes = await fetch(`${url}/expensive`, { headers: { 'payment-signature': 'SIG' } })
      assert.notEqual(expensiveRes.status, 200)
      assert.equal(expensiveRuns, 0)
    } finally {
      await fastify.close()
    }
  })
})

describe('routedockFastify — constructor validation', () => {
  it('throws when mpp-session mode is enabled without commitmentPublicKey', () => {
    assert.throws(
      () =>
        routedockFastify({
          ...BASE_OPTS,
          commitmentPublicKey: undefined,
          modes: ['mpp-session'],
          pricing: { 'mpp-session': { rate: '0.0001', channelFactory: CHANNEL_CONTRACT } },
        } as unknown as Parameters<typeof routedockFastify>[0]),
      /requirescommitmentPublicKey|commitmentPublicKey/i,
    )
  })
})
