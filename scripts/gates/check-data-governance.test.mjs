import assert from "node:assert/strict"
import test from "node:test"

import { quotedValues, schemaSummary } from "./check-data-governance.mjs"

test("quotedValues reads a const string tuple", () => {
  assert.deepEqual(
    quotedValues('export const VALUES = ["a", "b"] as const', "export const VALUES"),
    ["a", "b"]
  )
})

test("schemaSummary rejects non-monotonic history", () => {
  const source = `    this.version(2)\n    this.version(1)\n    // First full-chain construction`
  assert.throws(() => schemaSummary(source), /not strictly increasing/)
})

test("schemaSummary reports a deterministic digest", () => {
  const source = `    this.version(1)\n    this.version(3)\n    // First full-chain construction`
  const first = schemaSummary(source)
  assert.equal(first.latestVersion, 3)
  assert.equal(first.versionDeclarations, 2)
  assert.equal(first.schemaHistorySha256, schemaSummary(source).schemaHistorySha256)
})
