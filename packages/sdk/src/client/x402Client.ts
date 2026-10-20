import { createEd25519Signer, type ClientStellarSigner } from '@x402/stellar'
import { x402Client, x402HTTPClient } from '@x402/core/client'
import {
  decodePaymentRequiredHeader,
  decodePaymentResponseHeader,
} from '@x402/core/http'
import type { RouteDockManifest, PaymentResult } from '../types.js'
import {
  RouteDockManifestError,
  RouteDockPolicyRejectError,
  RouteDockSignatureError,
  httpStatusToError,
  paymentRejectedError,
  wrapFetchError,
} from '../errors.js'
import { stroopsToUsdc } from '../internal/usdc.js'
import { withRetry, type RetryPolicy } from '../internal/retry.js'
import { checkX402Accept, filterX402Accepts, type Caip2Network } from './challenge.js'
import { selectStellarScheme } from './nulthScheme.js'
import type { PaymentRequirements } from '@x402/core/types'

type Network = 'testnet' | 'mainnet'

const CAIP2: Record<Network, Caip2Network> = {
  testnet: 'stellar:testnet',
  mainnet: 'stellar:pubnet',
}

/** What an {@link X402PreSignHook} sees: the payment about to be signed. */
export interface X402PreSignContext {
  /** The resource being paid for. */
  readonly url: string
  /** The signed manifest the challenge was already bound to. */
  readonly manifest: RouteDockManifest
  /** The challenge entries that passed manifest binding — the signer picks from these. */
  readonly accepts: readonly PaymentRequirements[]
}

/** Verdict returned by an {@link X402PreSignHook}. */
export type X402PreSignDecision = { approve: true } | { approve: false; reason?: string }

/**
 * Optional guard run once per `pay()`, after the 402 challenge has been bound to
 * the manifest and immediately before anything is signed. Use it to plug in an
 * external or custom audit. Rejecting — or throwing — aborts before signing
 * (fail closed) with `RouteDockPolicyRejectError`.
 */
export type X402PreSignHook = (
  ctx: X402PreSignContext,
) => X402PreSignDecision | Promise<X402PreSignDecision>

/** Outcome of the retried unpaid probe. */
type ProbeOutcome =
  | { kind: 'free'; data: unknown }
  | { kind: 'payment-required'; init: Response }

export class X402Client {
  private readonly httpClient: x402HTTPClient
  private readonly signer: ClientStellarSigner

  constructor(
    secretKeyOrSigner: string | ClientStellarSigner,
    private readonly network: Network,
    private readonly retryPolicy?: RetryPolicy,
    private readonly preSignHook?: X402PreSignHook,
  ) {
    const caip2 = CAIP2[network]
    this.signer =
      typeof secretKeyOrSigner === 'string'
        ? createEd25519Signer(secretKeyOrSigner, caip2)
        : secretKeyOrSigner
    const scheme = selectStellarScheme(this.signer)
    const core = new x402Client()
    core.register(caip2, scheme)
    this.httpClient = new x402HTTPClient(core)
  }

  /** Replace signer (e.g. swap to Nulth ZK account payer before pay) */
  withSigner(signer: ClientStellarSigner): X402Client {
    return new X402Client(signer, this.network, this.retryPolicy, this.preSignHook)
  }

  async pay(url: string, manifest: RouteDockManifest): Promise<PaymentResult> {
    const pricing = manifest.pricing.x402
    if (!pricing) {
      throw new RouteDockManifestError('manifest.pricing.x402 missing')
    }
    if (!pricing.facilitator) {
      throw new RouteDockManifestError('manifest.pricing.x402.facilitator missing')
    }

    const caip2 = CAIP2[this.network]

    // Phase 1: unpaid probe. This can retry freely — no payment exists yet.
    const probe = await withRetry(async (): Promise<ProbeOutcome> => {
      let init: Response
      try {
        init = await fetch(url, { headers: { 'X-Preferred-Mode': 'x402' } })
      } catch (err) {
        throw wrapFetchError(err, 'x402 initial request')
      }

      if (init.status !== 402) {
        if (!init.ok) {
          throw httpStatusToError(
            `x402 initial request failed: HTTP ${init.status}`,
            init.status,
            init,
          )
        }
        let data: unknown
        try {
          data = await init.json()
        } catch {
          throw new RouteDockManifestError(
            `Failed to parse JSON from non-402 response (HTTP ${init.status})`,
          )
        }
        return { kind: 'free', data }
      }

      return { kind: 'payment-required', init }
    }, this.retryPolicy)

    if (probe.kind === 'free') {
      return { data: probe.data, txHash: null, mode: 'x402', amount: '0', timestamp: Date.now() }
    }

    const init = probe.init
    const reqHeader = init.headers.get('X-Payment-Requirements')
    if (!reqHeader) {
      throw new RouteDockManifestError('402 response missing X-Payment-Requirements header')
    }

    let paymentRequired
    try {
      paymentRequired = decodePaymentRequiredHeader(reqHeader)
    } catch (err) {
      throw new RouteDockManifestError('402 X-Payment-Requirements header is malformed', {
        cause: err,
      })
    }

    const firstAccept = paymentRequired.accepts[0]
    if (!firstAccept) {
      throw new RouteDockManifestError('402 response carries no payment accepts')
    }

    // Phase 2: bind the unsigned 402 to the signed manifest BEFORE signing.
    // A mismatched challenge must never reach createPaymentPayload.
    const allowed = filterX402Accepts(paymentRequired.accepts, manifest, caip2, pricing.amount)
    if (allowed.length === 0) {
      // `accepts` is non-empty here, so accepts[0] — the entry the scheme would
      // have signed — failed its own checks. That rejection is the report.
      throw checkX402Accept(firstAccept, manifest, caip2, pricing.amount)
    }

    // Optional pre-sign audit. Runs once, before signing; never on retries.
    if (this.preSignHook) {
      let decision: X402PreSignDecision
      try {
        decision = await this.preSignHook({ url, manifest, accepts: allowed })
      } catch (err) {
        throw new RouteDockPolicyRejectError('pre_sign_hook_error', { cause: err })
      }
      if (!decision || decision.approve !== true) {
        const reason = decision && decision.approve === false ? decision.reason : undefined
        throw new RouteDockPolicyRejectError(reason ?? 'pre_sign_rejected')
      }
    }

    // Phase 3: sign exactly once per pay() call.
    let paymentPayload
    try {
      paymentPayload = await this.httpClient.createPaymentPayload({
        ...paymentRequired,
        accepts: allowed,
      })
    } catch (err) {
      throw new RouteDockSignatureError(`x402 payment signing failed: ${String(err)}`, {
        cause: err,
      })
    }

    const paymentHeaders = this.httpClient.encodePaymentSignatureHeader(paymentPayload)
    const signedAmount = stroopsToUsdc(BigInt(paymentPayload.accepted.amount))

    // Phase 4: paid request. Retries reuse the SAME paymentHeaders object, so
    // the provider's idempotency store can replay the cached settlement rather
    // than charging a second time.
    const settled = await withRetry(async (): Promise<Response> => {
      let response: Response
      try {
        response = await fetch(url, { headers: paymentHeaders })
      } catch (err) {
        throw wrapFetchError(err, 'x402 settlement request')
      }

      if (!response.ok) {
        if (response.status >= 500 || response.status === 429 || response.status === 503) {
          throw httpStatusToError(
            `x402 payment failed: HTTP ${response.status}`,
            response.status,
            response,
          )
        }
        throw await paymentRejectedError('x402 payment failed', response.status, response)
      }

      return response
    }, this.retryPolicy)

    let txHash: string | null = null
    const responseHeader = settled.headers.get('X-Payment-Response')
    if (responseHeader) {
      try {
        const settleResponse = decodePaymentResponseHeader(responseHeader)
        txHash = (settleResponse as { transaction?: string }).transaction ?? null
      } catch {
        // non-fatal — some facilitators may omit the response header
      }
    }

    let data: unknown
    try {
      data = await settled.json()
    } catch {
      throw new RouteDockManifestError('Failed to parse JSON from settled response')
    }
    return { data, txHash, mode: 'x402', amount: signedAmount, timestamp: Date.now() }
  }
}
