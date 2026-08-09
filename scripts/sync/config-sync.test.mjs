/**
 * Coverage for scripts/sync/config-sync.mjs — pure helpers with an injected
 * read function (mirrors version-sync.test.mjs style).
 *
 * Run with: node --test scripts/sync/config-sync.test.mjs
 */

import { test } from "node:test"
import assert from "node:assert/strict"

import { CONFIGS, extractValue, replaceValue, checkConfigs, parseArgs } from "./config-sync.mjs"

const RUST = `pub const DEFAULT_PORT: u16 = 27890;\n`
const TSX = `// Mirrors Rust\nconst DEFAULT_PORT = 27890\n`
const SCANNER = `const DEFAULT_PORT = 27890\nexport const PROBE_PORTS: readonly number[] = [27890, 7890, 7891]\n`
const RESOLVER = `const DEFAULT_PORT = 27890\n`

function fixtureReader(overrides = {}) {
  const files = {
    "src-tauri/src/companion_api/server.rs": RUST,
    "components/settings/companion/companion-section.tsx": TSX,
    "lib/connectivity/lan-scanner.ts": SCANNER,
    "lib/connectivity/lan-resolver.ts": RESOLVER,
    ...overrides,
  }
  return (rel) => {
    if (!(rel in files)) throw new Error(`unexpected read: ${rel}`)
    return files[rel]
  }
}

test("parseArgs supports check mode and rejects unknown options", () => {
  assert.deepEqual(parseArgs([]), { check: false })
  assert.deepEqual(parseArgs(["--check"]), { check: true })
  assert.throws(() => parseArgs(["--unknown"]), /unknown option/i)
})

test("extractValue reads the Rust const, TS const and PROBE_PORTS head", () => {
  assert.equal(extractValue(RUST, CONFIGS[0].canonical.re), "27890")
  assert.equal(extractValue(TSX, /const DEFAULT_PORT = (\d+)/), "27890")
  assert.equal(extractValue(SCANNER, /PROBE_PORTS: readonly number\[\] = \[(\d+),/), "27890")
})

test("extractValue returns null when the pattern is absent", () => {
  assert.equal(extractValue("nothing here", /const DEFAULT_PORT = (\d+)/), null)
})

test("replaceValue splices only the captured span", () => {
  const next = replaceValue(TSX, /const DEFAULT_PORT = (\d+)/, "31000")
  assert.equal(next, `// Mirrors Rust\nconst DEFAULT_PORT = 31000\n`)
})

test("replaceValue throws when the pattern no longer matches", () => {
  assert.throws(() => replaceValue("nope", /const DEFAULT_PORT = (\d+)/, "1"), /no longer matches/)
})

test("checkConfigs is green when every mirror matches canonical", () => {
  const { drifted, missing } = checkConfigs(fixtureReader())
  assert.deepEqual(drifted, [])
  assert.deepEqual(missing, [])
})

test("checkConfigs reports a drifted mirror with current and expected values", () => {
  const { drifted } = checkConfigs(
    fixtureReader({ "lib/connectivity/lan-resolver.ts": `const DEFAULT_PORT = 7890\n` })
  )
  assert.equal(drifted.length, 1)
  assert.match(drifted[0].path, /lan-resolver/)
  assert.equal(drifted[0].current, "7890")
  assert.equal(drifted[0].expected, "27890")
  assert.equal(drifted[0].checkOnly, false)
})

test("checkConfigs flags a drifted PROBE_PORTS head as checkOnly", () => {
  const { drifted } = checkConfigs(
    fixtureReader({
      "lib/connectivity/lan-scanner.ts": `const DEFAULT_PORT = 27890\nexport const PROBE_PORTS: readonly number[] = [7890, 7891]\n`,
    })
  )
  assert.equal(drifted.length, 1)
  assert.equal(drifted[0].checkOnly, true)
})

test("checkConfigs reports a vanished pattern as missing (hard error), not drift", () => {
  const { drifted, missing } = checkConfigs(
    fixtureReader({ "components/settings/companion/companion-section.tsx": `// refactored away\n` })
  )
  assert.deepEqual(drifted, [])
  assert.equal(missing.length, 1)
  assert.match(missing[0].path, /companion-section/)
})

test("checkConfigs reports a vanished canonical source and skips its mirrors", () => {
  const { missing } = checkConfigs(
    fixtureReader({ "src-tauri/src/companion_api/server.rs": `// gone\n` })
  )
  assert.equal(missing.length, 1)
  assert.equal(missing[0].canonical, true)
})

test("CONFIGS shape: every mirror regex has exactly one capture group in practice", () => {
  for (const config of CONFIGS) {
    for (const mirror of [config.canonical, ...config.mirrors]) {
      // A capture-group-less regex would make extractValue return undefined.
      assert.ok(String(mirror.re).includes("("), `${mirror.path} regex lacks a capture group`)
    }
  }
})
