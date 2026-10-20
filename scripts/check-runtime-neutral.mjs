#!/usr/bin/env node
/**
 * Runtime-neutral bundle check.
 *
 * The SDK entries documented as Workers/browser-safe (`client`, `react`,
 * `provider/hono`, plus the `@routedock/nulth-sdk` package they depend on) must
 * not reach Node built-ins. A single `node:fs`, `node:crypto` or bare `Buffer`
 * in their built output breaks browsers and Workers without `nodejs_compat`.
 *
 * tsup/esbuild strips the `node:` prefix from built-ins, so this checks the
 * module specifier against Node's full built-in list, not just the prefix.
 *
 * Usage (after building both packages):
 *   node scripts/check-runtime-neutral.mjs
 *   node scripts/check-runtime-neutral.mjs --self-test
 */
import { builtinModules, createRequire } from 'node:module'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
const ts = require(require.resolve('typescript', { paths: [root] }))

/** Built output that must stay runtime-neutral (relative chunks are followed). */
export const NEUTRAL_ENTRIES = [
  'packages/sdk/dist/client.js',
  'packages/sdk/dist/client.cjs',
  'packages/sdk/dist/react.js',
  'packages/sdk/dist/react.cjs',
  'packages/sdk/dist/provider/hono.js',
  'packages/sdk/dist/provider/hono.cjs',
  'packages/nulth-sdk/dist/index.js',
  'packages/nulth-sdk/dist/index.cjs',
]

const BUILTINS = new Set(builtinModules.map((m) => m.replace(/^node:/, '')))
const FORBIDDEN_GLOBALS = new Set(['Buffer'])

export function isNodeBuiltin(specifier) {
  if (specifier.startsWith('node:')) return true
  return BUILTINS.has(specifier)
}

/** Return a list of human-readable violations found in one source text. */
export function scanSource(code, fileName = 'bundle.js') {
  const sf = ts.createSourceFile(fileName, code, ts.ScriptTarget.ES2022, true)
  const violations = []
  const relative = []
  const at = (node) => {
    const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf))
    return `${fileName}:${line + 1}`
  }
  const checkSpecifier = (node, spec) => {
    if (typeof spec !== 'string') return
    if (spec.startsWith('.')) relative.push(spec)
    else if (isNodeBuiltin(spec)) violations.push(`${at(node)} imports Node built-in "${spec}"`)
  }

  const visit = (node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      checkSpecifier(node, node.moduleSpecifier.text)
    } else if (ts.isCallExpression(node)) {
      const callee = node.expression
      const isRequire = ts.isIdentifier(callee) && callee.text === 'require'
      const isDynamicImport = callee.kind === ts.SyntaxKind.ImportKeyword
      const arg = node.arguments[0]
      if ((isRequire || isDynamicImport) && arg && ts.isStringLiteralLike(arg)) {
        checkSpecifier(node, arg.text)
      }
    } else if (ts.isIdentifier(node) && FORBIDDEN_GLOBALS.has(node.text)) {
      const p = node.parent
      const isMemberName = p && ts.isPropertyAccessExpression(p) && p.name === node
      const isKey = p && (ts.isPropertyAssignment(p) || ts.isMethodDeclaration(p)) && p.name === node
      const isTypeRef = p && ts.isTypeReferenceNode(p)
      if (!isMemberName && !isKey && !isTypeRef) {
        violations.push(`${at(node)} references the Node-only global "${node.text}"`)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return { violations, relative }
}

function scanFile(file, seen, out) {
  if (seen.has(file)) return
  seen.add(file)
  const { violations, relative } = scanSource(readFileSync(file, 'utf8'), file.replace(`${root}/`, ''))
  out.push(...violations)
  for (const rel of relative) {
    const target = resolve(dirname(file), rel)
    if (existsSync(target)) scanFile(target, seen, out)
  }
}

function selfTest() {
  const bad = [
    ["import fs from 'node:fs'", 1],
    ["import { createHash } from 'crypto'", 1],
    ["import path from 'path'", 1],
    ["export * from 'fs/promises'", 1],
    ["const x = require('node:crypto')", 1],
    ["const m = await import('buffer')", 1],
    ['const b = Buffer.from("x")', 1],
    ['let s: Buffer', 0], // type position in TS only; JS output never has it
    ['const ok = obj.Buffer', 0],
    ["import { Keypair } from '@stellar/stellar-sdk'", 0],
    ["import './chunk.js'", 0],
    ["// Buffer in a comment and 'node:fs' in a string", 0],
  ]
  let failed = 0
  for (const [code, expected] of bad) {
    const { violations } = scanSource(code, 'self-test.ts')
    if (violations.length !== expected) {
      failed++
      console.error(`self-test FAILED (${violations.length} != ${expected}): ${code}`)
    }
  }
  if (failed) process.exit(1)
  console.log(`runtime-neutral self-test ok (${bad.length} cases)`)
}

function main() {
  if (process.argv.includes('--self-test')) return selfTest()

  const missing = NEUTRAL_ENTRIES.map((f) => resolve(root, f)).filter((f) => !existsSync(f))
  if (missing.length) {
    console.error('Missing build output. Build first:')
    console.error('  pnpm --filter @routedock/nulth-sdk build && pnpm --filter @routedock/routedock build')
    for (const f of missing) console.error(`  missing: ${f.replace(`${root}/`, '')}`)
    process.exit(1)
  }

  const violations = []
  const seen = new Set()
  for (const f of NEUTRAL_ENTRIES) scanFile(resolve(root, f), seen, violations)

  if (violations.length) {
    console.error('Runtime-neutral check FAILED. These entries must not use Node built-ins or Buffer:')
    for (const v of violations) console.error(`  ✘ ${v}`)
    console.error(
      '\nUse the helpers in packages/sdk/src/internal/{encoding,hash}.ts instead. Node-only code belongs behind "@routedock/routedock/node".',
    )
    process.exit(1)
  }
  console.log(`runtime-neutral check ok (${NEUTRAL_ENTRIES.length} entries, ${seen.size} files scanned)`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
