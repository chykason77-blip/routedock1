/**
 * End-to-End Integration Tests for RouteDock Agent
 *
 * This test suite validates the complete autonomous payment workflow across all
 * three payment modes (x402, MPP charge, MPP session) against live provider
 * services on Stellar testnet.
 *
 * Run with: pnpm --filter agent test:e2e
 *
 * Prerequisites:
 *   - Stellar testnet access via Horizon API
 *   - Funded agent keypair (AGENT_SECRET with USDC balance)
 *   - Running provider services (local or remote)
 *   - Network connectivity
 *
 * Environment Variables:
 *   STELLAR_NETWORK      Network to use (default: testnet)
 *   AGENT_SECRET         Stellar secret key (required, must start with S)
 *   COMMITMENT_SECRET    Ed25519 keypair for MPP session (optional)
 *   PROVIDER_A_URL       URL of price provider (default: http://localhost:3001)
 *   PROVIDER_B_URL       URL of orderbook provider (default: http://localhost:3002)
 *   AGENT_DAILY_CAP_USDC Daily spending cap in USDC (default: 0.002)
 */

import path from 'node:path'
import os from 'node:os'
import assert from 'node:assert/strict'
import { Keypair } from '@stellar/stellar-sdk'
import { RouteDockClient, RouteDockPolicyRejectedError } from '@routedock/routedock'
import { FileSpendStore } from '@routedock/routedock/node'

// ── Config ────────────────────────────────────────────────────────────────────

const STELLAR_NETWORK = (process.env['STELLAR_NETWORK'] ?? 'testnet') as 'testnet' | 'mainnet'
const AGENT_SECRET = process.env['AGENT_SECRET'] ?? ''
const PROVIDER_A_URL = (process.env['PROVIDER_A_URL'] ?? 'http://localhost:3001').replace(/\/$/, '')
const PROVIDER_B_URL = (process.env['PROVIDER_B_URL'] ?? 'http://localhost:3002').replace(/\/$/, '')
const AGENT_DAILY_CAP_USDC = process.env['AGENT_DAILY_CAP_USDC'] ?? '0.002'
const COMMITMENT_SECRET = process.env['COMMITMENT_SECRET'] ?? ''

const TARGET_VOUCHERS = 50
const PROVIDER_A_PRICE_STROOPS = 100_000 // 0.001 USDC

// ── Logging ───────────────────────────────────────────────────────────────────

function log(test: string, msg: string): void {
  const ts = new Date().toISOString()
  console.log(`[${ts}] [${test}] ${msg}`)
}

// ── Test Suite ────────────────────────────────────────────────────────────────

async function runTests(): Promise<void> {
  log('setup', 'Starting RouteDock E2E test suite')
  log('setup', `Network: ${STELLAR_NETWORK}`)
  log('setup', `Provider A: ${PROVIDER_A_URL}`)
  log('setup', `Provider B: ${PROVIDER_B_URL}`)
  log('setup', `Daily cap: ${AGENT_DAILY_CAP_USDC} USDC`)

  // ── Validation: Required environment variables ────────────────────────────
  if (!AGENT_SECRET || !AGENT_SECRET.startsWith('S')) {
    throw new Error(
      'FATAL: AGENT_SECRET is required and must be a valid Stellar secret key (S...)',
    )
  }

  const keypair = Keypair.fromSecret(AGENT_SECRET)
  const agentAddress = keypair.publicKey()
  log('setup', `Agent address: ${agentAddress}`)

  const spendStorePath =
    process.env['AGENT_SPEND_STORE_PATH'] ??
    process.env['ROUTEDOCK_SPEND_STORE_PATH'] ??
    path.join(os.homedir(), '.routedock', 'spend.json')

  // Capture SDK debug lines so an x402 failure can be diagnosed from the
  // test output alone (#553: intermittent "x402 should have txHash").
  const sdkDebugLines: string[] = []
  const sdkLogger = (level: string, msg: string, fields?: Record<string, unknown>): void => {
    const line = `[${level}] ${msg}${fields ? ` ${JSON.stringify(fields)}` : ''}`
    sdkDebugLines.push(line)
    if (process.env['E2E_SDK_DEBUG'] === 'true') log('sdk', line)
  }

  const client = new RouteDockClient({
    wallet: keypair,
    network: STELLAR_NETWORK,
    spendCap: { daily: AGENT_DAILY_CAP_USDC, asset: 'USDC' },
    spendStore: new FileSpendStore(spendStorePath),
    commitmentSecret: COMMITMENT_SECRET || undefined,
    logger: sdkLogger,
  })

  // ── Test 1: x402 discrete query ────────────────────────────────────────────
  log('x402', 'Running x402 discrete query test...')

  // Unpaid probe recorded up front: when the settlement below misbehaves, the
  // probe status and headers distinguish "paywall answered 2xx" (free path,
  // amount '0') from "paid 2xx without a usable X-Payment-Response".
  let probeStatus = 'unavailable'
  let probeHeaders: Record<string, string> = {}
  try {
    const probe = await fetch(`${PROVIDER_A_URL}/price`, {
      headers: { 'X-Preferred-Mode': 'x402' },
    })
    probeStatus = String(probe.status)
    probeHeaders = Object.fromEntries(probe.headers.entries())
  } catch (err) {
    probeStatus = `fetch failed: ${err instanceof Error ? err.message : String(err)}`
  }

  const dumpX402Diagnostics = (): void => {
    log('x402', `unpaid probe status: ${probeStatus}`)
    log('x402', `unpaid probe headers: ${JSON.stringify(probeHeaders)}`)
    log('x402', `SDK debug lines (${sdkDebugLines.length}):`)
    for (const line of sdkDebugLines) log('x402', `  ${line}`)
  }

  let x402Result: any
  try {
    x402Result = await client.pay(`${PROVIDER_A_URL}/price`, { forceMode: 'x402' })
  } catch (err) {
    if (
      err instanceof Error &&
      (err.message.includes('ECONNREFUSED') || err.message.includes('fetch failed'))
    ) {
      if (process.env.CI && process.env.E2E_ALLOW_SKIP !== 'true') {
        throw err
      }
      log(
        'x402',
        'SKIP: Provider A unavailable (connection refused). Ensure Provider A is running.',
      )
      return
    }
    dumpX402Diagnostics()
    throw err
  }

  assert(x402Result, 'x402 result should exist')
  try {
    assert.equal(x402Result.mode, 'x402', `expected mode x402, got ${x402Result.mode}`)
    // A settled x402 payment must carry a real transaction hash. An empty
    // string means the provider served a settle that never landed, and
    // amount '0' means the paywall was never engaged — both are failures,
    // not successes to be logged (#553).
    assert(
      x402Result.txHash !== null && x402Result.txHash !== undefined && x402Result.txHash !== '',
      `x402 should have a non-empty txHash (got ${JSON.stringify(x402Result.txHash)})`,
    )
    assert(
      x402Result.amount !== undefined && x402Result.amount !== null && x402Result.amount !== '0',
      `x402 amount should be a paid amount, not '0' (free response), got ${JSON.stringify(x402Result.amount)}`,
    )
    assert(x402Result.data, 'x402 should have response data')
    assert(x402Result.amount, 'x402 should have amount paid')
  } catch (assertErr) {
    log(
      'x402',
      `result: mode=${x402Result.mode} amount=${x402Result.amount} txHash=${JSON.stringify(x402Result.txHash)}`,
    )
    dumpX402Diagnostics()
    throw assertErr
  }
  log('x402', `✓ mode=${x402Result.mode} amount=${x402Result.amount} USDC`)
  log('x402', `✓ txHash=${x402Result.txHash}`)

  // ── Test 2: MPP charge query ───────────────────────────────────────────────
  log('mpp-charge', 'Running MPP charge query test...')

  const chargeResult = await client.pay(`${PROVIDER_A_URL}/price`)

  assert(chargeResult, 'charge result should exist')
  assert(
    chargeResult.mode === 'mpp-charge' || chargeResult.mode === 'x402',
    `expected mpp-charge or x402, got ${chargeResult.mode}`,
  )
  assert(chargeResult.data, 'charge should have response data')
  assert(chargeResult.amount, 'charge should have amount paid')
  log('mpp-charge', `✓ mode=${chargeResult.mode} amount=${chargeResult.amount} USDC`)
  if (chargeResult.txHash) {
    log('mpp-charge', `✓ txHash=${chargeResult.txHash}`)
  } else {
    log('mpp-charge', '✓ txHash=null (expected for session vouchers)')
  }

  // ── Test 3: MPP session streaming ──────────────────────────────────────────
  log('mpp-session', 'Running MPP session streaming test...')

  let session: any
  try {
    session = await client.openSession(`${PROVIDER_B_URL}/stream/orderbook`)
  } catch (err) {
    if (
      err instanceof Error &&
      (err.message.includes('ECONNREFUSED') || err.message.includes('fetch failed'))
    ) {
      if (process.env.CI && process.env.E2E_ALLOW_SKIP !== 'true') {
        throw err
      }
      log(
        'mpp-session',
        'SKIP: Provider B unavailable (connection refused). Ensure Provider B is running.',
      )
      return
    }
    throw err
  }

  assert(session, 'session handle should exist')
  assert(session.channelId, 'session should have channelId')
  // The channel is pre-deployed, so the client issues no open transaction and
  // openTxHash is null — it must NOT be the contract address (channelId).
  assert(session.openTxHash === null, 'session openTxHash should be null for a pre-deployed channel')
  assert(session.openTxHash !== session.channelId, 'openTxHash must not be the contract address')
  log('mpp-session', `✓ Channel opened: ${session.channelId}`)
  log('mpp-session', `✓ openTxHash=${session.openTxHash ?? 'null (pre-deployed channel)'}`)

  // Consume vouchers from stream
  let voucherCount = 0
  let lastError: Error | null = null

  try {
    for await (const item of session.stream()) {
      voucherCount++

      // Validate each item is an object (SSE event)
      assert(item, `voucher ${voucherCount} should not be null`)

      if (voucherCount % 10 === 0) {
        log('mpp-session', `  ...consumed ${voucherCount} vouchers`)
      }

      if (voucherCount >= TARGET_VOUCHERS) {
        break
      }
    }
  } catch (err) {
    lastError = err instanceof Error ? err : new Error(String(err))
    // Continue to close the session even if streaming failed
    log('mpp-session', `⚠ Stream error after ${voucherCount} vouchers: ${lastError.message}`)
  }

  // Validate voucher consumption
  assert(voucherCount > 0, `should have consumed at least 1 voucher, got ${voucherCount}`)
  log('mpp-session', `✓ Consumed ${voucherCount} vouchers`)

  // Close the session
  const closeResult = await session.close()

  assert(closeResult, 'close result should exist')
  assert(closeResult.closeTxHash, 'session should have closeTxHash')
  assert(closeResult.totalPaid, 'session should have totalPaid')
  assert.equal(
    closeResult.vouchersIssued,
    voucherCount,
    `vouchersIssued ${closeResult.vouchersIssued} should match consumed ${voucherCount}`,
  )
  log('mpp-session', `✓ Channel closed: ${closeResult.closeTxHash}`)
  log('mpp-session', `✓ Total paid: ${closeResult.totalPaid} USDC`)
  log('mpp-session', `✓ Vouchers issued: ${closeResult.vouchersIssued}`)

  // ── Test 4: Policy rejection ───────────────────────────────────────────────
  log('policy', 'Running policy rejection test...')

  // Calculate expected cumulative spend:
  // x402 (0.001) + mpp-charge (0.0008) + mpp-session (0.005 for 50 vouchers)
  // = 0.0068 USDC
  // Adding another x402 (0.001) = 0.0078, which is way over cap of 0.002
  // So it should be rejected locally.

  let policyRejected = false
  let rejectionReason = ''

  try {
    await client.pay(`${PROVIDER_A_URL}/price`, { forceMode: 'x402' })
    log('policy', '✗ Payment succeeded when it should have been rejected')
  } catch (err) {
    if (err instanceof RouteDockPolicyRejectedError) {
      policyRejected = true
      rejectionReason = err.reason
      log('policy', `✓ Policy rejection confirmed: ${rejectionReason}`)
    } else {
      throw err
    }
  }

  assert(policyRejected, 'policy should have been rejected due to daily cap exceeded')
  assert(rejectionReason.includes('cap'), `rejection reason should mention cap, got: ${rejectionReason}`)

  // ── Summary ────────────────────────────────────────────────────────────────
  log('summary', '─'.repeat(70))
  log('summary', 'RouteDock E2E Test Suite: ALL TESTS PASSED ✓')
  log('summary', '─'.repeat(70))
  log('summary', 'Test results:')
  log('summary', '  ✓ x402 discrete query')
  log('summary', '  ✓ MPP charge query')
  log('summary', `  ✓ MPP session (${voucherCount} vouchers consumed, 2 on-chain tx)`)
  log('summary', '  ✓ Policy rejection (daily cap enforced locally)')
  log('summary', '─'.repeat(70))
}

// ── Main ──────────────────────────────────────────────────────────────────────

runTests().catch((err: unknown) => {
  console.error('[E2E Test] Fatal error:', err)
  process.exit(1)
})
