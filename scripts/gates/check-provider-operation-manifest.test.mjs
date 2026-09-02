import assert from "node:assert/strict"
import test from "node:test"

import {
  AI_SDK_THROAT,
  checkAiSdkThroat,
  compareOperationSets,
  extractFrozenIds,
  extractHandlerOperationIds,
  extractNamedExports,
  loadManifest,
  validateManifest,
} from "./check-provider-operation-manifest.mjs"

function descriptor(overrides = {}) {
  return {
    id: "models.list",
    group: "discovery",
    operation: "read",
    risk: "low",
    idempotency: "structural",
    billing: "free",
    scopes: ["provider:read"],
    surfaces: ["renderer", "sidecar"],
    remoteExposure: "client",
    piiGate: "none",
    streaming: "never",
    statefulHandle: "none",
    inputSchema: "modelsListInput",
    outputSchema: "modelsListOutput",
    ...overrides,
  }
}

test("accepts a complete descriptor", () => {
  assert.deepEqual(validateManifest({ schemaVersion: 1, operations: [descriptor()] }), [])
})

test("rejects bad ids, duplicates, unknown enums and unmetered mutations", () => {
  const errors = validateManifest({
    schemaVersion: 1,
    operations: [
      descriptor({ id: "models" }),
      descriptor(),
      descriptor(),
      descriptor({ id: "files.delete", operation: "write", idempotency: "structural" }),
      descriptor({ id: "x.y", group: "nope", scopes: ["root"], surfaces: [] }),
    ],
  })
  assert(errors.some((e) => e.includes("invalid operation id")))
  assert(errors.some((e) => e.includes("duplicate operation")))
  assert(errors.some((e) => e.includes("mutations require idempotency")))
  assert(errors.some((e) => e.includes("invalid group")))
  assert(errors.some((e) => e.includes("invalid scope root")))
  assert(errors.some((e) => e.includes("at least one surface")))
})

test("schema references must be named exports that exist", () => {
  const errors = validateManifest(
    { schemaVersion: 1, operations: [descriptor({ inputSchema: "#/components/schemas/X" })] },
    { schemaExports: new Set(["modelsListOutput"]) }
  )
  assert(errors.some((e) => e.includes("must be a named export identifier")))
  const missing = validateManifest(
    { schemaVersion: 1, operations: [descriptor()] },
    { schemaExports: new Set(["modelsListOutput"]) }
  )
  assert(missing.some((e) => e.includes('"modelsListInput" is not exported')))
})

test("the manifest and the frozen id list must agree in both directions", () => {
  const errors = validateManifest(
    { schemaVersion: 1, operations: [descriptor()] },
    { frozenIds: ["models.list", "models.get"] }
  )
  assert.deepEqual(errors, [
    "models.get: present in PROVIDER_OPERATION_IDS but not in the manifest",
  ])
  const extra = validateManifest(
    { schemaVersion: 1, operations: [descriptor(), descriptor({ id: "auth.status" })] },
    { frozenIds: ["models.list"] }
  )
  assert.deepEqual(extra, [
    "auth.status: present in the manifest but not in PROVIDER_OPERATION_IDS",
  ])
})

test("source extractors read export names and the frozen list", () => {
  assert.deepEqual(
    [...extractNamedExports("export const a = 1\nconst b = 2\nexport const cD = z")],
    ["a", "cD"]
  )
  assert.deepEqual(
    extractFrozenIds('export const PROVIDER_OPERATION_IDS = [\n  "a.b",\n  "c-d.e",\n] as const'),
    ["a.b", "c-d.e"]
  )
})

test("the checked-in manifest validates", () => {
  const manifest = loadManifest()
  assert.equal(manifest.schemaVersion, 1)
  assert.deepEqual(validateManifest(manifest), [])
  assert(manifest.operations.length >= 47)
})

test("handlers must bind described operations", () => {
  const manifest = { operations: [{ id: "models.list" }] }
  assert.deepEqual(
    compareOperationSets(manifest, new Map([["lib/ai/operations/handlers/a.ts", ["models.list"]]])),
    []
  )
  assert.deepEqual(
    compareOperationSets(
      manifest,
      new Map([["lib/ai/operations/handlers/a.ts", ["models.list", "models.summon"]]])
    ),
    ["lib/ai/operations/handlers/a.ts: handler with no descriptor: models.summon"]
  )
  assert.deepEqual(
    extractHandlerOperationIds('foo({ operationId: "files.upload" })\nbar({operationId:"x.y"})'),
    ["files.upload", "x.y"]
  )
})

test("only the AI SDK throat may import ai or @ai-sdk", () => {
  const sources = new Map([
    [AI_SDK_THROAT, 'import { embed } from "ai"'],
    ["lib/ai/operations/handlers/language.ts", 'import { x } from "./ai-sdk-surface"'],
    ["lib/ai/operations/handlers/rogue.ts", 'import { createOpenAI } from "@ai-sdk/openai"'],
  ])
  const errors = checkAiSdkThroat(sources)
  assert.equal(errors.length, 1)
  assert.match(errors[0], /rogue\.ts: imports the AI SDK/)
})
