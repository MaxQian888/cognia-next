#!/usr/bin/env node
/**
 * Provider operation manifest gate (ADR-0163).
 *
 * Validates `protocol/provider-operations.json` against its vocabulary and
 * against the two TypeScript files that make it mean something:
 *   - `packages/provider-types/src/provider-operations.ts` owns the frozen id
 *     list (the JSON and the list must match exactly, both directions),
 *   - `packages/provider-types/src/provider-operation-schemas.ts` must export
 *     every `inputSchema` / `outputSchema` name by name. A `$ref` string that
 *     every descriptor points at the same way proves nothing, so schema
 *     references are named exports and this gate checks they exist.
 *
 * Usage: pnpm provider-ops:check
 */

import { readFileSync, readdirSync, realpathSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..")

export const ID_PATTERN = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/

export const ENUMS = {
  group: new Set(["discovery", "language", "retrieval", "media", "files-jobs", "account"]),
  operation: new Set(["read", "write", "side-effect"]),
  risk: new Set(["low", "high", "critical"]),
  idempotency: new Set(["structural", "required", "forbidden"]),
  billing: new Set(["free", "metered", "metered-unknown"]),
  remoteExposure: new Set(["client", "execution", "host-admin"]),
  piiGate: new Set(["outbound-text", "none"]),
  streaming: new Set(["never", "optional", "always"]),
  statefulHandle: new Set(["none", "provider-pinned"]),
}
export const SCOPES = new Set([
  "provider:read",
  "provider:invoke",
  "provider:write",
  "provider:files",
  "provider:jobs",
  "account:read",
])
export const SURFACES = new Set(["renderer", "sidecar", "rust-proxy"])

/**
 * Structural validation of the manifest alone.
 *
 * @param {unknown} manifest
 * @param {{ schemaExports?: Set<string>, frozenIds?: string[] }} [context]
 * @returns {string[]} errors
 */
export function validateManifest(manifest, context = {}) {
  const errors = []
  if (!manifest || manifest.schemaVersion !== 1 || !Array.isArray(manifest.operations)) {
    return ["manifest must have schemaVersion 1 and an operations array"]
  }

  const ids = new Set()
  for (const op of manifest.operations) {
    const label = op?.id || "<unnamed>"
    if (typeof op?.id !== "string" || !ID_PATTERN.test(op.id)) {
      errors.push(`${label}: invalid operation id`)
      continue
    }
    if (ids.has(op.id)) errors.push(`${label}: duplicate operation`)
    ids.add(op.id)
    for (const [field, allowed] of Object.entries(ENUMS)) {
      if (!allowed.has(op[field])) errors.push(`${label}: invalid ${field}`)
    }
    if (!Array.isArray(op.scopes) || op.scopes.length === 0) {
      errors.push(`${label}: at least one scope is required`)
    } else {
      for (const scope of op.scopes) {
        if (!SCOPES.has(scope)) errors.push(`${label}: invalid scope ${scope}`)
      }
    }
    if (!Array.isArray(op.surfaces) || op.surfaces.length === 0) {
      errors.push(`${label}: at least one surface is required`)
    } else {
      for (const surface of op.surfaces) {
        if (!SURFACES.has(surface)) errors.push(`${label}: invalid surface ${surface}`)
      }
    }
    if (op.operation !== "read" && op.idempotency !== "required") {
      errors.push(`${label}: mutations require idempotency`)
    }
    for (const field of ["inputSchema", "outputSchema"]) {
      const name = op[field]
      if (typeof name !== "string" || !/^[a-z][A-Za-z0-9]*$/.test(name)) {
        errors.push(`${label}: ${field} must be a named export identifier`)
      } else if (context.schemaExports && !context.schemaExports.has(name)) {
        errors.push(`${label}: ${field} "${name}" is not exported by provider-operation-schemas.ts`)
      }
    }
  }

  if (context.frozenIds) {
    const frozen = new Set(context.frozenIds)
    for (const id of ids) {
      if (!frozen.has(id))
        errors.push(`${id}: present in the manifest but not in PROVIDER_OPERATION_IDS`)
    }
    for (const id of frozen) {
      if (!ids.has(id))
        errors.push(`${id}: present in PROVIDER_OPERATION_IDS but not in the manifest`)
    }
  }
  return errors
}

/** `export const foo = ...` names in a TypeScript source. */
export function extractNamedExports(source) {
  return new Set([...source.matchAll(/^export const ([A-Za-z0-9_]+)\b/gm)].map((m) => m[1]))
}

/** The string literals of `PROVIDER_OPERATION_IDS = [ ... ] as const`. */
export function extractFrozenIds(source) {
  const match = source.match(/PROVIDER_OPERATION_IDS = \[([\s\S]*?)\] as const/)
  if (!match) throw new Error("Could not locate PROVIDER_OPERATION_IDS")
  return [...match[1].matchAll(/"([a-z0-9.-]+)"/g)].map((m) => m[1])
}

/**
 * Handler registrations parsed from source: every `operationId: "<id>"` in
 * `lib/ai/operations/handlers/*.ts` (tests excluded). Static on purpose, the
 * handlers import app modules Node cannot load here. The dynamic direction
 * (every served matrix cell has a handler) is `lib/ai/operations/
 * contract-parity.test.ts`.
 */
export function extractHandlerOperationIds(source) {
  return [...source.matchAll(/operationId:\s*"([a-z0-9.-]+)"/g)].map((m) => m[1])
}

/**
 * Bidirectional handler ↔ descriptor check, the static half. Mirrors
 * `compareCommandSets` in the companion manifest gate.
 *
 * @param {{ operations: Array<{ id: string }> }} manifest
 * @param {Map<string, string[]>} handlersByFile file → operation ids it binds
 */
export function compareOperationSets(manifest, handlersByFile) {
  const errors = []
  const ids = new Set(manifest.operations.map((op) => op.id))
  for (const [file, operationIds] of handlersByFile) {
    for (const id of operationIds) {
      if (!ids.has(id)) errors.push(`${file}: handler with no descriptor: ${id}`)
    }
  }
  return errors
}

const AI_IMPORT = /(?:^|\n)\s*import\s+[^;'"]*?from\s*["'](?:ai|@ai-sdk\/[^"']+)["']/g
export const AI_SDK_THROAT = "lib/ai/operations/handlers/ai-sdk-surface.ts"

/**
 * Exactly one file under lib/ai/operations may import the AI SDK. The PII
 * boundary gate is import-shaped, so a second importer is a second
 * allowlist entry, which is how that gate goes hollow.
 */
export function checkAiSdkThroat(sourcesByFile) {
  const errors = []
  for (const [file, source] of sourcesByFile) {
    if (file === AI_SDK_THROAT) continue
    if (AI_IMPORT.test(source)) {
      errors.push(`${file}: imports the AI SDK; only ${AI_SDK_THROAT} may`)
    }
    AI_IMPORT.lastIndex = 0
  }
  return errors
}

function listOperationSources(root = repoRoot) {
  const dir = resolve(root, "lib/ai/operations")
  const out = new Map()
  const walk = (relative) => {
    for (const entry of readdirSync(resolve(dir, relative), { withFileTypes: true })) {
      const rel = relative ? `${relative}/${entry.name}` : entry.name
      if (entry.isDirectory()) walk(rel)
      else if (/\.ts$/.test(entry.name) && !/\.test\.ts$/.test(entry.name)) {
        out.set(`lib/ai/operations/${rel}`, readFileSync(resolve(dir, rel), "utf8"))
      }
    }
  }
  walk("")
  return out
}

export function loadManifest(root = repoRoot) {
  return JSON.parse(readFileSync(resolve(root, "protocol/provider-operations.json"), "utf8"))
}

function main() {
  const manifest = loadManifest()
  const schemaSource = readFileSync(
    resolve(repoRoot, "packages/provider-types/src/provider-operation-schemas.ts"),
    "utf8"
  )
  const typesSource = readFileSync(
    resolve(repoRoot, "packages/provider-types/src/provider-operations.ts"),
    "utf8"
  )
  const sources = listOperationSources()
  const handlersByFile = new Map(
    [...sources]
      .filter(([file]) => file.startsWith("lib/ai/operations/handlers/"))
      .map(([file, source]) => [file, extractHandlerOperationIds(source)])
  )
  const errors = [
    ...validateManifest(manifest, {
      schemaExports: extractNamedExports(schemaSource),
      frozenIds: extractFrozenIds(typesSource),
    }),
    ...compareOperationSets(manifest, handlersByFile),
    ...checkAiSdkThroat(sources),
  ]
  if (errors.length > 0) {
    console.error(`[provider-operation-manifest] ${errors.length} issue(s):`)
    for (const error of errors) console.error(`  - ${error}`)
    return 1
  }
  const bound = new Set([...handlersByFile.values()].flat())
  console.log(
    `[provider-operation-manifest] OK: ${manifest.operations.length} descriptors, every schema named, ` +
      `${bound.size} operation(s) bound by handlers, one AI SDK throat.`
  )
  return 0
}

const isDirectRun = (() => {
  if (!process.argv[1]) return false
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
})()

if (isDirectRun) process.exit(main())
