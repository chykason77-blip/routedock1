/**
 * Issue #561: the local spend cap is a single USDC accumulator, so it must
 * never count (or silently let through) a payment in another asset.
 *
 * Run with: pnpm --filter @routedock/routedock test
 */

import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import assert from 'node:assert/strict'
import { Keypair } from '@stellar/stellar-sdk'
import { RouteDockClient } from '../RouteDockClient.js'
import { InMemorySpendStore } from '../../store/SpendStore.js'
import { RouteDockPolicyRejectError } from '../../errors.js'
import { signManifest } from '../../manifest/sign.js'
import type { AssetConfig, PaymentResult, RouteDockManifest } from '../../types.js'

const PAYEE = Keypair.random()
const USDC_CONTRACT = 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA'
const XLM_CONTRACT = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC'

function startServer(manifest: RouteDockManifest): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      if (req.url === '/.well-known/routedock.json') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(manifest))
      } else {
        res.writeHead(404)
        res.end()
      }
    })
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number }
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise<void>((r) => server.close(() => r())),
      })
    })
  })
}

function makeManifest(opts: {
  rootAsset: 'USDC' | 'XLM'
  assets?: AssetConfig[]
  modes?: Array<'x402' | 'mpp-charge' | 'mpp-session'>
}): RouteDockManifest {
  const modes = opts.modes ?? ['mpp-charge']
  const pricing: RouteDockManifest['pricing'] = {}
  if (modes.includes('x402')) {
    pricing.x402 = { amount: '5', per: 'request', facilitator: 'https://channels.openzeppelin.com/x402/testnet' }
  }
  if (modes.includes('mpp-charge')) pricing['mpp-charge'] = { amount: '5', per: 'request' }
  if (modes.includes('mpp-session')) {
    pricing['mpp-session'] = {
      rate: '0.0001',
      per: 'voucher',
      channel_factory: 'CCK4XOW3YKQUEZFONUTINKMSNW7SNMRQZURME5U3UP7E6WNGK7UHUCAH',
      min_deposit: '0.10',
      refund_waiting_period_ledgers: 17280,
    }
  }
  return signManifest(
    {
      routedock: '1.0',
      name: 'Cap Asset Test Provider',
      description: 'Provider for spend cap asset tests',
      modes,
      network: 'testnet',
      asset: opts.rootAsset,
      asset_contract: opts.rootAsset === 'XLM' ? XLM_CONTRACT : USDC_CONTRACT,
      ...(opts.assets && { assets: opts.assets }),
      payee: PAYEE.publicKey(),
      pricing,
      endpoints: { test: { method: 'GET', path: '/test' } },
      tags: ['test'],
    },
    PAYEE.secret(),
  )
}

function stubTrustline(client: RouteDockClient, asset: string): void {
  const kp = (client as any).keypair as Keypair
  const network = (client as any).network as string
  ;(RouteDockClient as any)._trustlineCache.set(`${network}:${kp.publicKey()}:${asset}`, {
    exists: true,
    expiresAt: Date.now() + 300_000,
  })
}

function fakeResult(mode: string, amount: string): PaymentResult {
  return { data: { ok: true }, txHash: 'deadbeef', mode: mode as any, amount, timestamp: Date.now() }
}

function newClient(store: InMemorySpendStore, withCap = true): RouteDockClient {
  return new RouteDockClient({
    wallet: Keypair.random(),
    network: 'testnet',
    commitmentSecret: 'a'.repeat(64),
    ...(withCap && { spendCap: { daily: '1.00', asset: 'USDC' as const } }),
    spendStore: store,
  })
}

async function rejectReason(p: Promise<unknown>): Promise<string> {
  try {
    await p
  } catch (err) {
    assert.ok(err instanceof RouteDockPolicyRejectError, `expected policy reject, got ${String(err)}`)
    return err.reason
  }
  assert.fail('expected rejection')
}

// ── 1: XLM-priced manifest + USDC cap → rejected, nothing counted ─────────────
{
  const server = await startServer(makeManifest({ rootAsset: 'XLM' }))
  try {
    const store = new InMemorySpendStore({ warn: false })
    const client = newClient(store)
    let paid = false
    let trustlineChecked = false
    ;(client as any).charge.pay = async () => { paid = true; return fakeResult('mpp-charge', '5') }
    ;(client as any)._checkTrustline = async () => { trustlineChecked = true }

    const reason = await rejectReason(client.pay(`${server.url}/test`))
    assert.equal(reason, 'local_cap_asset_mismatch')
    assert.equal(paid, false, 'must not pay in an asset the cap cannot account for')
    assert.equal(trustlineChecked, false, 'must fail before any trustline/network work')
    const state = await store.read()
    assert.ok(!state || state.totalMicros === '0', 'XLM must never be added to the USDC total')
    console.log('✓ Test 1: XLM-selected payment is rejected under a USDC cap and not counted')
  } finally {
    await server.close()
  }
}

// ── 2: multi-asset manifest — cap follows the asset actually selected ─────────
{
  const assets: AssetConfig[] = [
    { asset: 'XLM', asset_contract: XLM_CONTRACT, modes: ['x402'] },
    { asset: 'USDC', asset_contract: USDC_CONTRACT, modes: ['mpp-charge'] },
  ]

  // Provider that only offers x402 → selected asset is XLM → rejected.
  const xlmServer = await startServer(makeManifest({ rootAsset: 'XLM', assets, modes: ['x402'] }))
  // Provider that only offers mpp-charge → selected asset is USDC (root asset is XLM) → counted.
  const usdcServer = await startServer(makeManifest({ rootAsset: 'XLM', assets, modes: ['mpp-charge'] }))
  try {
    const store = new InMemorySpendStore({ warn: false })
    const client = new RouteDockClient({
      wallet: Keypair.random(),
      network: 'testnet',
      spendCap: { daily: '10.00', asset: 'USDC' },
      spendStore: store,
    })
    stubTrustline(client, 'USDC')
    let x402Paid = false
    ;(client as any).x402.pay = async () => { x402Paid = true; return fakeResult('x402', '5') }
    ;(client as any).charge.pay = async () => fakeResult('mpp-charge', '5')

    const reason = await rejectReason(client.pay(`${xlmServer.url}/test`))
    assert.equal(reason, 'local_cap_asset_mismatch')
    assert.equal(x402Paid, false)
    assert.ok(!(await store.read()), 'XLM must not touch the accumulator')

    await client.pay(`${usdcServer.url}/test`)
    const state = await store.read()
    assert.ok(state)
    assert.equal(state.totalMicros, '50000000', 'USDC payment counted as before')
    console.log('✓ Test 2: multi-asset manifest — XLM selection rejected, USDC selection counted')
  } finally {
    await xlmServer.close()
    await usdcServer.close()
  }
}

// ── 3: USDC-only manifest is unchanged ────────────────────────────────────────
{
  const server = await startServer(makeManifest({ rootAsset: 'USDC' }))
  try {
    const store = new InMemorySpendStore({ warn: false })
    const client = new RouteDockClient({
      wallet: Keypair.random(),
      network: 'testnet',
      spendCap: { daily: '10.00', asset: 'USDC' },
      spendStore: store,
    })
    stubTrustline(client, 'USDC')
    ;(client as any).charge.pay = async () => fakeResult('mpp-charge', '5')
    await client.pay(`${server.url}/test`)
    const state = await store.read()
    assert.ok(state)
    assert.equal(state.totalMicros, '50000000')
    console.log('✓ Test 3: USDC-only manifest behaves exactly as before')
  } finally {
    await server.close()
  }
}

// ── 4: no cap configured → XLM payments are not blocked ───────────────────────
{
  const server = await startServer(makeManifest({ rootAsset: 'XLM' }))
  try {
    const store = new InMemorySpendStore({ warn: false })
    const client = newClient(store, false)
    stubTrustline(client, 'XLM')
    let paid = false
    ;(client as any).charge.pay = async () => { paid = true; return fakeResult('mpp-charge', '5') }
    await client.pay(`${server.url}/test`)
    assert.equal(paid, true)
    console.log('✓ Test 4: without a spendCap, XLM payments are unaffected')
  } finally {
    await server.close()
  }
}

// ── 5: openSession rejects before opening a channel ───────────────────────────
{
  const server = await startServer(makeManifest({ rootAsset: 'XLM', modes: ['mpp-session'] }))
  try {
    const store = new InMemorySpendStore({ warn: false })
    const client = newClient(store)
    let opened = false
    ;(client as any).session.openSession = async () => { opened = true; return {} }

    const reason = await rejectReason(client.openSession(`${server.url}/test`))
    assert.equal(reason, 'local_cap_asset_mismatch')
    assert.equal(opened, false, 'channel (on-chain deposit) must not open')
    console.log('✓ Test 5: openSession under a USDC cap rejects XLM before opening the channel')
  } finally {
    await server.close()
  }
}

// ── 6: defense in depth — the reserve step itself refuses other assets ────────
{
  const store = new InMemorySpendStore({ warn: false })
  const client = newClient(store)
  const reason = await rejectReason((client as any)._checkAndReserveSpend('5', 'https://x.example', 'XLM'))
  assert.equal(reason, 'local_cap_asset_mismatch')
  const state = await store.read()
  assert.ok(!state || state.totalMicros === '0')
  console.log('✓ Test 6: _checkAndReserveSpend refuses non-cap assets')
}

console.log('\nAll spend-cap asset tests passed.')
