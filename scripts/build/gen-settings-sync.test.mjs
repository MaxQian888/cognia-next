import assert from "node:assert/strict"
import { test } from "node:test"
import { readFileSync } from "node:fs"

import {
  bucketize,
  genSettingsSync,
  loadTable,
  renderRequestSchemaCatalog,
  renderRust,
  parseArgs,
} from "./gen-settings-sync.mjs"

const TABLE_SOURCE = "packages/agent-config-types/src/settings-sync.ts"

const FAKE_TABLE = `
export const SETTINGS_SYNC = {
  zebra: { category: "shared" },
  alpha: { category: "shared" },
  relay: { category: "server-authoritative", rationale: "belongs to the deployment" },
  mic: { category: "device-local", rationale: "an OS-issued device id" },
  secret: { category: "desktop-only" },
}
`

test("parseArgs supports check mode and rejects unknown options", () => {
  assert.deepEqual(parseArgs([]), { check: false })
  assert.deepEqual(parseArgs(["--check"]), { check: true })
  assert.throws(() => parseArgs(["--unknown"]), /unknown option/i)
})

test("loadTable evaluates the TypeScript table without a compiler", async () => {
  const table = await loadTable(FAKE_TABLE)
  assert.equal(table.zebra.category, "shared")
  assert.equal(table.mic.rationale, "an OS-issued device id")
})

test("bucketize sorts keys and drops desktop-only from every bucket", async () => {
  const { shared, serverAuthoritative, deviceLocal } = bucketize(await loadTable(FAKE_TABLE))
  assert.deepEqual(shared, ["alpha", "zebra"])
  assert.deepEqual(serverAuthoritative, [["relay", "belongs to the deployment"]])
  assert.deepEqual(deviceLocal, [["mic", "an OS-issued device id"]])
})

test("renderRust emits only shared keys and explains every exclusion", async () => {
  const rust = renderRust(bucketize(await loadTable(FAKE_TABLE)))
  assert.match(rust, /pub const APP_SETTINGS_MOBILE_ALLOWED_KEYS/)
  assert.match(rust, /^ {4}"alpha",$/m)
  assert.match(rust, /^ {4}"zebra",$/m)
  // A non-shared key must never reach the constant...
  assert.doesNotMatch(rust, /^ {4}"(relay|mic|secret)",$/m)
  // ...but the two deliberate exclusions must be justified in the doc header,
  // so a reader who expects one there finds the reason instead of a hole.
  assert.match(rust, /`relay` — server-authoritative/)
  assert.match(rust, /belongs to the deployment/)
  assert.match(rust, /`mic` — device-local/)
  assert.match(rust, /an OS-issued device id/)
})

test("renderRust comment blocks stay separated", async () => {
  const rust = renderRust(bucketize(await loadTable(FAKE_TABLE)))
  // Regression: the entries were once joined without a newline, producing
  // `...deployment.//!` and a malformed doc comment.
  assert.doesNotMatch(rust, /[^\n]\/\/!/)
})

test("renderRequestSchemaCatalog updates only the canonical settings enum", () => {
  const source = JSON.stringify({
    schemaVersion: 1,
    commands: {
      app_settings_update: {
        properties: { patch: { propertyNames: { enum: [] }, description: "keep" } },
      },
      untouched: { type: "object" },
    },
  })
  const next = JSON.parse(renderRequestSchemaCatalog(source, ["alpha", "zebra"]))
  assert.deepEqual(next.commands.app_settings_update.properties.patch.propertyNames.enum, [
    "alpha",
    "zebra",
  ])
  assert.equal(next.commands.app_settings_update.properties.patch.description, "keep")
  assert.deepEqual(next.commands.untouched, { type: "object" })
})

test("renderRequestSchemaCatalog refuses a missing canonical schema path", () => {
  assert.throws(
    () => renderRequestSchemaCatalog('{"commands":{}}', ["alpha"]),
    /app_settings_update\.patch\.propertyNames\.enum is missing/
  )
})

test("every non-shared classification in the real table carries a rationale", async () => {
  const table = await loadTable(readFileSync(TABLE_SOURCE, "utf8"))
  const missing = Object.entries(table)
    .filter(
      ([, entry]) =>
        (entry.category === "server-authoritative" || entry.category === "device-local") &&
        !entry.rationale?.trim()
    )
    .map(([key]) => key)
  assert.deepEqual(missing, [], `these need a rationale: ${missing.join(", ")}`)
})

test("the real table classifies transport config as never-writable", async () => {
  const table = await loadTable(readFileSync(TABLE_SOURCE, "utf8"))
  // Pinned because the old hand-written allowlist had these backwards: the
  // phone could write them but never received them, so a self-hosted signaling
  // server or TURN relay could not reach it.
  for (const key of ["signalingUrl", "iceServers", "turnServers"]) {
    assert.equal(table[key].category, "server-authoritative", `${key} must flow down only`)
  }
  assert.equal(table.turnProvider.category, "desktop-only")
  assert.equal(table.webrtcEnabled.category, "device-local")
})

test("checking the committed artifacts reports no drift", async () => {
  assert.deepEqual(await genSettingsSync({ check: true }), [])
})

test("check mode reports drift instead of silently rewriting", async () => {
  /** @type {string[]} */ const written = []
  const errors = await genSettingsSync({
    check: true,
    read: (path) => (path === TABLE_SOURCE ? FAKE_TABLE : readFileSync(path, "utf8")),
    write: (path) => written.push(path),
  })
  assert.equal(written.length, 0)
  assert.ok(errors.length > 0)
  assert.ok(errors.every((error) => error.includes("settings-sync:gen")))
})
