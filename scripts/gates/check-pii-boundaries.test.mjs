import assert from "node:assert/strict"
import { test } from "node:test"
import {
  auditFile,
  extractImports,
  isAiBoundary,
  isAuditedProductionFile,
} from "./check-pii-boundaries.mjs"

test("extractImports ignores type-only imports and finds dynamic boundaries", () => {
  const imports = extractImports(
    `import type { Model } from "ai"\nconst sdk = await import("@ai-sdk/openai")`
  )
  assert.deepEqual(imports, ["@ai-sdk/openai"])
})

test("isAiBoundary recognizes SDK and cloud embedding seams", () => {
  assert.equal(isAiBoundary("ai"), true)
  assert.equal(isAiBoundary("@ai-sdk/anthropic"), true)
  assert.equal(isAiBoundary("@cognia/provider-embedding/embedding"), true)
  assert.equal(isAiBoundary("@cognia/redact"), false)
})

test("production scan excludes generated declarations but keeps executable TypeScript", () => {
  assert.equal(isAuditedProductionFile("plugins/generated/provider.d.ts"), false)
  assert.equal(isAuditedProductionFile("lib/runtime.ts"), true)
  assert.equal(isAuditedProductionFile("lib/runtime.test.ts"), false)
})

test("unreviewed boundary fails while a redactor import passes", () => {
  const unsafe = `import { generateText } from "ai"`
  assert.deepEqual(auditFile("lib/unsafe.ts", unsafe, []), [
    { file: "lib/unsafe.ts", boundary: "ai" },
  ])
  const safe = `${unsafe}\nimport { redactText } from "@cognia/redact"`
  assert.deepEqual(auditFile("lib/safe.ts", safe, []), [])
})

test("explicit file and boundary allowlist suppresses only its reviewed seam", () => {
  const source = `import { generateText } from "ai"\nimport { openai } from "@ai-sdk/openai"`
  const allowlist = [
    { file: "lib/x.ts", boundaries: ["ai"], reason: "user prompt", protection: "user-directed" },
  ]
  assert.deepEqual(auditFile("lib/x.ts", source, allowlist), [
    { file: "lib/x.ts", boundary: "@ai-sdk/openai" },
  ])
})
