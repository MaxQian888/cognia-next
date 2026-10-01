#!/usr/bin/env node

import { createHash } from "node:crypto"
import { readFile, writeFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import path from "node:path"
import { COMPANION_SOURCES } from "./lib/companion-source-paths.mjs"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")

export function quotedValues(source, declaration) {
  const start = source.indexOf(declaration)
  if (start < 0) throw new Error(`Missing declaration: ${declaration}`)
  const end = source.indexOf("]", start)
  if (end < 0) throw new Error(`Unterminated declaration: ${declaration}`)
  return [...source.slice(start, end).matchAll(/"([A-Za-z0-9_:-]+)"/g)].map((match) => match[1])
}

/**
 * Fingerprint the single current schema declaration.
 *
 * This used to hash the append-only version chain, on the theory that history
 * is immutable and any edit to it is data corruption. `schema.ts` now declares
 * one cumulative version instead, so the thing worth pinning is the CURRENT
 * store set: the baseline turns any unreviewed edit to `CURRENT_SCHEMA` into a
 * gate failure, and re-running `pnpm db:governance:write` is the deliberate
 * acknowledgement.
 *
 * The version number is read from `CURRENT_SCHEMA_VERSION` rather than counted,
 * and the baseline records it, so lowering or forgetting to raise it is caught
 * here. IndexedDB only upgrades on an increase, so an un-bumped edit would
 * otherwise be silently ignored by every existing database.
 */
export function schemaSummary(source) {
  const versionMatch = source.match(/^export const CURRENT_SCHEMA_VERSION = (\d+)$/m)
  if (!versionMatch) throw new Error("Unable to locate CURRENT_SCHEMA_VERSION in lib/db/schema.ts")

  const start = source.indexOf("export const CURRENT_SCHEMA: Record<string, string | null> = {")
  if (start < 0) throw new Error("Unable to locate the CURRENT_SCHEMA declaration")
  const end = source.indexOf("\n}\n", start)
  if (end < 0) throw new Error("Unterminated CURRENT_SCHEMA declaration")
  const declaration = `${source.slice(start, end).replaceAll("\r\n", "\n").trimEnd()}\n}\n`

  return {
    latestVersion: Number(versionMatch[1]),
    schemaSha256: createHash("sha256").update(declaration).digest("hex"),
  }
}

/**
 * The `table: "…"` names inside the `DEFAULT_HANDLERS` array literal.
 *
 * The array is cut at its own closing bracket, found by depth: handler
 * entries carry nested arrays (`after: ["characters"]`), and cutting at the
 * first `]` read only the entries before the first of them — three tables
 * out of forty-eight, reported as drift.
 */
export function handlerTableNames(source) {
  const declaration = source.indexOf("const DEFAULT_HANDLERS")
  if (declaration < 0) throw new Error("Unable to locate DEFAULT_HANDLERS in the sync handlers")
  const open = source.indexOf("= [", declaration)
  if (open < 0) throw new Error("Unable to locate the DEFAULT_HANDLERS array")
  let depth = 0
  for (let index = open + 2; index < source.length; index++) {
    const char = source[index]
    if (char === "[") depth += 1
    else if (char === "]") {
      depth -= 1
      if (depth === 0) {
        const block = source.slice(open, index + 1)
        return [...block.matchAll(/table:\s*"([A-Za-z0-9_]+)"/g)].map((match) => match[1])
      }
    }
  }
  throw new Error("Unterminated DEFAULT_HANDLERS array")
}

/**
 * The `table: "strategy"` pairs of `COMPANION_SYNC_DELETE_STRATEGY`, cut at the
 * object literal's own closing brace.
 */
export function deleteStrategies(source) {
  const declaration = source.indexOf("export const COMPANION_SYNC_DELETE_STRATEGY")
  if (declaration < 0) throw new Error("Missing declaration: COMPANION_SYNC_DELETE_STRATEGY")
  const open = source.indexOf("= {", declaration)
  const close = source.indexOf("\n}", open)
  if (open < 0 || close < 0) throw new Error("Unterminated COMPANION_SYNC_DELETE_STRATEGY")
  const entries = [...source.slice(open, close).matchAll(/^\s*([A-Za-z0-9_]+):\s*"([a-z-]+)",?$/gm)]
  return new Map(entries.map((match) => [match[1], match[2]]))
}

/** `name` → `has_tombstones` for every descriptor in the Rust `default_tables()` block. */
export function rustTombstoneFlags(rustBlock) {
  const flags = new Map()
  const pattern = /name:\s*"([A-Za-z0-9_]+)"\.to_string\(\),[\s\S]*?has_tombstones:\s*(true|false)/g
  for (const match of rustBlock.matchAll(pattern)) flags.set(match[1], match[2] === "true")
  return flags
}

/**
 * A pull only carries rows that still exist, so every synced table must say
 * how a Host delete reaches the client, and the tables that say `tombstoned`
 * must be exactly the ones the Rust registry advertises as tombstoned.
 */
export function assertDeleteStrategies(protocolTables, strategies, rustFlags) {
  const allowed = new Set(["tombstoned", "retention-pruned", "never-deleted", "singleton"])
  assertSame([...strategies.keys()].sort(), protocolTables, "Catalog/delete strategy")
  for (const [table, strategy] of strategies) {
    if (!allowed.has(strategy)) throw new Error(`Unknown delete strategy for ${table}: ${strategy}`)
    const tombstoned = strategy === "tombstoned"
    if (rustFlags.get(table) !== tombstoned) {
      throw new Error(
        `Delete strategy drifted for ${table}: catalog says ${strategy}, Rust has_tombstones is ${rustFlags.get(table)}`
      )
    }
  }
}

function sortedUnique(values, label) {
  const unique = [...new Set(values)].sort()
  if (unique.length !== values.length) throw new Error(`${label} contains duplicate entries`)
  return unique
}

function assertSame(left, right, label) {
  if (JSON.stringify(left) !== JSON.stringify(right)) {
    throw new Error(`${label} drifted\nleft: ${left.join(", ")}\nright: ${right.join(", ")}`)
  }
}

export async function collectGovernanceSummary(base = root) {
  const [schema, catalog, handlers, rust] = await Promise.all([
    readFile(path.join(base, "lib/db/schema.ts"), "utf8"),
    readFile(path.join(base, "lib/data-governance/table-catalog.ts"), "utf8"),
    readFile(path.join(base, "lib/sync/companion-sync.ts"), "utf8"),
    readFile(path.join(base, COMPANION_SOURCES.syncRegistry), "utf8"),
  ])
  const schemaTables = sortedUnique(
    [...schema.matchAll(/^  ([A-Za-z_][A-Za-z0-9_]*)!:\s*Table</gm)].map((match) => match[1]),
    "CogniaDB table declarations"
  )
  const catalogTables = sortedUnique(
    quotedValues(catalog, "export const CORE_TABLE_NAMES"),
    "catalog"
  )
  assertSame(schemaTables, catalogTables, "Schema/catalog")

  const protocolTables = sortedUnique(
    quotedValues(catalog, "export const COMPANION_SYNC_PROTOCOL_TABLE_NAMES"),
    "sync protocol catalog"
  )
  const handlerTables = sortedUnique(handlerTableNames(handlers), "TypeScript sync handlers")
  const rustBlock = rust.slice(rust.indexOf("fn default_tables()"), rust.indexOf("#[cfg(test)]"))
  const rustTables = sortedUnique(
    [...rustBlock.matchAll(/name:\s*"([A-Za-z0-9_]+)"\.to_string\(\)/g)].map((match) => match[1]),
    "Rust sync registry"
  )
  assertSame(protocolTables, handlerTables, "Catalog/TypeScript sync")
  assertSame(protocolTables, rustTables, "Catalog/Rust sync")
  assertDeleteStrategies(protocolTables, deleteStrategies(catalog), rustTombstoneFlags(rustBlock))

  return {
    ...schemaSummary(schema),
    staticTableCount: schemaTables.length,
    companionSyncTableCount: protocolTables.length,
    companionSyncTables: protocolTables,
    catalog: "lib/data-governance/table-catalog.ts",
  }
}

async function main() {
  const summary = await collectGovernanceSummary()
  const outputPath = path.join(root, "docs/data-governance.generated.json")
  const rendered = `${JSON.stringify(summary, null, 2)}\n`
  if (process.argv.includes("--write")) {
    await writeFile(outputPath, rendered)
    process.stdout.write(`Wrote ${path.relative(root, outputPath)}\n`)
    return
  }
  const committed = await readFile(outputPath, "utf8")
  if (committed !== rendered) {
    throw new Error("Generated governance summary is stale; run pnpm db:governance:write")
  }
  process.stdout.write(
    `Data governance OK: schema v${summary.latestVersion}, ${summary.staticTableCount} tables, ${summary.companionSyncTableCount} sync tables\n`
  )
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  })
}
