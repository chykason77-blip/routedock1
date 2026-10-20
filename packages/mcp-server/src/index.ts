import { config as loadDotenv } from 'dotenv'
import path from 'path'
import os from 'os'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { RouteDockClient } from '@routedock/routedock'
import { FileSpendStore } from '@routedock/routedock/node'
import type { SessionHandle } from '@routedock/routedock'
import { createClient } from '@supabase/supabase-js'
import { TOOLS } from './tools.js'
import {
  handlePayForData,
  handleOpenSession,
  handleStreamSession,
  handleCloseSession,
  handleCheckBalance,
  handleListProviders,
  type HandlerDeps,
  type PayForDataArgs,
  type OpenSessionArgs,
  type StreamSessionArgs,
  type CloseSessionArgs,
  type CheckBalanceArgs,
  type ListProvidersArgs,
} from './handlers.js'
// Load environment variables (supports .env files for external secret management)
const envPath = process.env.ROUTEDOCK_ENV_FILE
if (envPath) {
  loadDotenv({ path: envPath })
} else {
  loadDotenv()
}

// Environment variables
const STELLAR_SECRET = process.env.STELLAR_SECRET || process.env.ROUTEDOCK_WALLET_SECRET
const STELLAR_NETWORK = (process.env.STELLAR_NETWORK || 'testnet') as 'testnet' | 'mainnet'
const COMMITMENT_SECRET = process.env.COMMITMENT_SECRET
const SUPABASE_URL = process.env.SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_KEY || process.env.SUPABASE_SERVICE_KEY

if (process.env.SUPABASE_SERVICE_KEY) {
  console.warn('WARNING: Using SUPABASE_SERVICE_KEY bypasses RLS. Use an anon key for list_providers (anon + public_read_providers RLS is sufficient).')
}

if (!STELLAR_SECRET) {
  console.error('Error: STELLAR_SECRET or ROUTEDOCK_WALLET_SECRET environment variable is required')
  process.exit(1)
}

const ROUTEDOCK_DAILY_CAP = process.env.ROUTEDOCK_DAILY_CAP
if (!ROUTEDOCK_DAILY_CAP) {
  console.error('Error: ROUTEDOCK_DAILY_CAP environment variable is required to prevent unbounded spending')
  process.exit(1)
}

const spendStorePath = process.env.ROUTEDOCK_SPEND_STORE_PATH || path.join(os.homedir(), '.routedock', 'spend.json')

// Initialize RouteDock client
const client = new RouteDockClient({
  wallet: STELLAR_SECRET,
  network: STELLAR_NETWORK,
  commitmentSecret: COMMITMENT_SECRET,
  spendCap: { daily: ROUTEDOCK_DAILY_CAP, asset: 'USDC' },
  spendStore: new FileSpendStore(spendStorePath),
})

// Initialize Supabase client for provider registry
let supabase: ReturnType<typeof createClient> | null = null
if (SUPABASE_URL && SUPABASE_KEY) {
  supabase = createClient(SUPABASE_URL, SUPABASE_KEY)
}

// Sessions opened via open_session, keyed by channelId, so a later
// close_session/stream_session call in the same server process can find the
// live handle again. If the process restarts, in-flight sessions are not
// recoverable here — the SDK's own maxDurationMs guard still auto-closes the
// underlying channel on-chain so collateral is never stranded indefinitely.
const openSessions = new Map<string, SessionHandle>()

// Shared dependency bundle passed into every handler
const deps: HandlerDeps = {
  client,
  openSessions,
  supabase: supabase as HandlerDeps['supabase'],
  stellarSecret: STELLAR_SECRET,
  stellarNetwork: STELLAR_NETWORK,
}

// Tool definitions live in tools.ts so they can be imported and tested
// independently without triggering index.ts side-effects.

// Create MCP server
const server = new Server(
  {
    name: '@routedock/mcp-server',
    version: '0.1.0',
  },
  {
    capabilities: {
      tools: {},
    },
  }
)

// List tools handler
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return { tools: TOOLS }
})

// Call tool handler — delegates to pure handler functions in handlers.ts
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params

  try {
    switch (name) {
      case 'pay_for_data':
        return await handlePayForData(args as unknown as PayForDataArgs, deps)

      case 'open_session':
        return await handleOpenSession(args as unknown as OpenSessionArgs, deps, COMMITMENT_SECRET)

      case 'stream_session':
        return await handleStreamSession(args as unknown as StreamSessionArgs, deps)

      case 'close_session':
        return await handleCloseSession(args as unknown as CloseSessionArgs, deps)

      case 'check_balance':
        return await handleCheckBalance(args as unknown as CheckBalanceArgs, deps)

      case 'list_providers':
        return await handleListProviders(args as unknown as ListProvidersArgs, deps)

      default:
        throw new Error(`Unknown tool: ${name}`)
    }
  } catch (error) {
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            success: false,
            error: error instanceof Error ? error.message : String(error),
          }, null, 2),
        },
      ],
      isError: true,
    }
  }
})

// Start server
async function main() {
  const transport = new StdioServerTransport()
  await server.connect(transport)
  console.error('@routedock/mcp-server running on stdio')
}

main().catch((error) => {
  console.error('Server error:', error)
  process.exit(1)
})
