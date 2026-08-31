import assert from "node:assert/strict"
import test from "node:test"

import { quotedValues, schemaSummary } from "./check-data-governance.mjs"

const SCHEMA = [
  "export const CURRENT_SCHEMA_VERSION = 213",
  "",
  "export const CURRENT_SCHEMA: Record<string, string | null> = {",
  '  sessions: "id, updatedAt",',
  "  droppedTable: null,",
  "}",
  "",
  "let somethingElse = 0",
].join("\n")

test("quotedValues reads a const string tuple", () => {
  assert.deepEqual(
    quotedValues('export const VALUES = ["a", "b"] as const', "export const VALUES"),
    ["a", "b"]
  )
})

test("schemaSummary reads the declared version rather than counting blocks", () => {
  assert.equal(schemaSummary(SCHEMA).latestVersion, 213)
})

test("schemaSummary reports a deterministic digest", () => {
  assert.equal(schemaSummary(SCHEMA).schemaSha256, schemaSummary(SCHEMA).schemaSha256)
})

test("schemaSummary digest changes when a store spec changes", () => {
  const edited = SCHEMA.replace('"id, updatedAt"', '"id, updatedAt, createdAt"')
  assert.notEqual(schemaSummary(SCHEMA).schemaSha256, schemaSummary(edited).schemaSha256)
})

test("schemaSummary digest ignores code after the declaration", () => {
  const trailing = `${SCHEMA}\nlet added = 1\n`
  assert.equal(schemaSummary(SCHEMA).schemaSha256, schemaSummary(trailing).schemaSha256)
})

test("schemaSummary refuses a file with no version constant", () => {
  const source = SCHEMA.replace("export const CURRENT_SCHEMA_VERSION = 213", "")
  assert.throws(() => schemaSummary(source), /CURRENT_SCHEMA_VERSION/)
})

test("schemaSummary refuses a file with no schema declaration", () => {
  assert.throws(
    () => schemaSummary("export const CURRENT_SCHEMA_VERSION = 213\n"),
    /CURRENT_SCHEMA declaration/
  )
})
