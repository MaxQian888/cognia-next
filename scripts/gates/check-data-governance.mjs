#!/usr/bin/env node

import { createHash } from "node:crypto"
import { readFile, writeFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import path from "node:path"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")

export function quotedValues(source, declaration) {
  const start = source.indexOf(declaration)
  if (start < 0) throw new Error(`Missing declaration: ${declaration}`)
  const end = source.indexOf("]", start)
  if (end < 0) throw new Error(`Unterminated declaration: ${declaration}`)
  return [...source.slice(start, end).matchAll(/"([A-Za-z0-9_:-]+)"/g)].map((match) => match[1])
}

export function schemaSummary(source) {
  const start = source.indexOf("    this.version(")
  const end = source.indexOf("    // First full-chain construction", start)
  if (start < 0 || end < 0) throw new Error("Unable to locate the append-only schema history")
  const history = `${source.slice(start, end).replaceAll("\r\n", "\n").trimEnd()}\n`
  const versions = [...history.matchAll(/this\.version\((\d+)\)/g)].map((match) => Number(match[1]))
  for (let index = 1; index < versions.length; index += 1) {
    if (versions[index] <= versions[index - 1]) {
      throw new Error(
        `Schema versions are not strictly increasing at ${versions[index - 1]} -> ${versions[index]}`
      )
    }
  }
  return {
    latestVersion: Math.max(...versions),
    versionDeclarations: versions.length,
    schemaHistorySha256: createHash("sha256").update(history).digest("hex"),
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
    readFile(path.join(base, "src-tauri/src/companion_api/sync_registry.rs"), "utf8"),
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
  const handlerStart = handlers.indexOf("const DEFAULT_HANDLERS")
  const handlerArrayStart = handlers.indexOf("= [", handlerStart)
  const handlerBlock = handlers.slice(handlerArrayStart, handlers.indexOf("]", handlerArrayStart))
  const handlerTables = sortedUnique(
    [...handlerBlock.matchAll(/table:\s*"([A-Za-z0-9_]+)"/g)].map((match) => match[1]),
    "TypeScript sync handlers"
  )
  const rustBlock = rust.slice(rust.indexOf("fn default_tables()"), rust.indexOf("#[cfg(test)]"))
  const rustTables = sortedUnique(
    [...rustBlock.matchAll(/name:\s*"([A-Za-z0-9_]+)"\.to_string\(\)/g)].map((match) => match[1]),
    "Rust sync registry"
  )
  assertSame(protocolTables, handlerTables, "Catalog/TypeScript sync")
  assertSame(protocolTables, rustTables, "Catalog/Rust sync")

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
