import assert from "node:assert/strict"
import test from "node:test"

import {
  assertDeleteStrategies,
  deleteStrategies,
  handlerTableNames,
  quotedValues,
  rustTombstoneFlags,
  schemaSummary,
} from "./check-data-governance.mjs"

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

test("handlerTableNames reads past nested arrays inside a handler entry", () => {
  const source = [
    "const DEFAULT_HANDLERS: RegisteredHandler[] = [",
    '  { table: "settings", stage: "critical", run: a },',
    '  { table: "sessions", stage: "critical", run: b, after: ["characters"] },',
    '  { table: "messages", stage: "deferred", run: c, after: ["sessions", "characters"] },',
    "]",
    'const OTHER = [{ table: "notAHandler" }]',
  ].join("\n")
  assert.deepEqual(handlerTableNames(source), ["settings", "sessions", "messages"])
})

test("handlerTableNames refuses a file with no handler array", () => {
  assert.throws(() => handlerTableNames("const x = 1\n"), /DEFAULT_HANDLERS/)
})

const CATALOG = [
  "export const COMPANION_SYNC_DELETE_STRATEGY: Readonly<",
  "  Record<CompanionSyncProtocolTableName, CompanionSyncDeleteStrategy>",
  "> = {",
  '  skills: "tombstoned",',
  '  settings: "singleton",',
  "}",
].join("\n")

const RUST = [
  "fn default_tables() -> Vec<SyncTableDescriptor> {",
  '    SyncTableDescriptor { name: "skills".to_string(), description: "x".to_string(), has_tombstones: true },',
  "    SyncTableDescriptor {",
  '        name: "settings".to_string(),',
  "        // a comment between the name and the flag",
  '        description: "y".to_string(),',
  "        has_tombstones: false,",
  "    },",
].join("\n")

test("deleteStrategies reads every table of the strategy map", () => {
  assert.deepEqual(
    [...deleteStrategies(CATALOG)],
    [
      ["skills", "tombstoned"],
      ["settings", "singleton"],
    ]
  )
})

test("rustTombstoneFlags pairs each name with its own flag across comments", () => {
  assert.deepEqual(
    [...rustTombstoneFlags(RUST)],
    [
      ["skills", true],
      ["settings", false],
    ]
  )
})

test("assertDeleteStrategies accepts a catalog that matches the registry", () => {
  assertDeleteStrategies(
    ["settings", "skills"],
    deleteStrategies(CATALOG),
    rustTombstoneFlags(RUST)
  )
})

test("assertDeleteStrategies refuses a synced table with no strategy", () => {
  assert.throws(
    () =>
      assertDeleteStrategies(
        ["plugins", "settings", "skills"],
        deleteStrategies(CATALOG),
        rustTombstoneFlags(RUST)
      ),
    /Catalog\/delete strategy drifted/
  )
})

test("assertDeleteStrategies refuses a tombstoned table the registry does not tombstone", () => {
  const flags = rustTombstoneFlags(RUST)
  flags.set("skills", false)
  assert.throws(
    () => assertDeleteStrategies(["settings", "skills"], deleteStrategies(CATALOG), flags),
    /Delete strategy drifted for skills/
  )
})

test("assertDeleteStrategies refuses an unknown strategy", () => {
  const strategies = deleteStrategies(CATALOG)
  strategies.set("skills", "forgotten")
  assert.throws(
    () => assertDeleteStrategies(["settings", "skills"], strategies, rustTombstoneFlags(RUST)),
    /Unknown delete strategy for skills/
  )
})
