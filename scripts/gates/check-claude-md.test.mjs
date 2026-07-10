/**
 * Coverage for scripts/gates/check-claude-md.mjs — the pure parser and
 * invariant checker. Filesystem readers are exercised against the real repo
 * (read-only), the checker against injected fixtures.
 *
 * Run with: node --test scripts/gates/check-claude-md.test.mjs
 */

import { test } from "node:test"
import assert from "node:assert/strict"

import {
  extractMapRows,
  checkInvariants,
  readAdrNumbers,
  readDexieCeiling,
} from "./check-claude-md.mjs"

const FIXTURE_MD = `# CLAUDE.md

## Subsystem Map

intro line

| Subsystem | Lives in | Schema | ADR |
| --------- | -------- | ------ | --- |
| Twin      | \`lib/twin/\`, \`components/twin/\` | v14 | 0003 |
| Fleet     | \`lib/fleet/\` | v105 | — (no ADR yet) |
| Globby    | \`sidecar/dispatch/compaction*.mjs\`, \`redact.ts:hasNoLeakingPii\` | — | 0063 |

### Cross-cutting hooks

- not a table row
`

test("extractMapRows parses rows, skips header/divider, filters globs and symbol refs", () => {
  const rows = extractMapRows(FIXTURE_MD)
  assert.equal(rows.length, 3)
  assert.deepEqual(rows[0], {
    subsystem: "Twin",
    livesIn: ["lib/twin/", "components/twin/"],
    adrs: [3],
  })
  // "— (no ADR yet)" yields no ADR numbers.
  assert.deepEqual(rows[1].adrs, [])
  // Glob and `path:symbol` tokens are excluded from existence checks.
  assert.deepEqual(rows[2].livesIn, [])
  assert.deepEqual(rows[2].adrs, [63])
})

test("extractMapRows returns [] when there is no Subsystem Map section", () => {
  assert.deepEqual(extractMapRows("# CLAUDE.md\n\nno map here"), [])
})

test("checkInvariants passes on a consistent fixture", () => {
  const failures = checkInvariants({
    md: FIXTURE_MD,
    adrNumbers: [3, 63],
    dexieCeiling: 105,
    pathExists: () => true,
  })
  assert.deepEqual(failures, [])
})

test("checkInvariants flags missing paths, unknown ADRs, unreferenced newest ADR, stale ceiling", () => {
  const failures = checkInvariants({
    md: FIXTURE_MD,
    adrNumbers: [3, 63, 67], // 0067 exists on disk but is not in the doc
    dexieCeiling: 106, // schema moved past what the doc mentions
    pathExists: (p) => p !== "components/twin/",
  })
  assert.ok(failures.some((f) => f.includes("components/twin/")))
  assert.ok(failures.some((f) => f.includes("0067")))
  assert.ok(failures.some((f) => f.includes("v106")))
})

test("checkInvariants flags an ADR referenced in the map but absent on disk", () => {
  const failures = checkInvariants({
    md: FIXTURE_MD,
    adrNumbers: [3], // 0063 referenced by the Globby row is gone
    dexieCeiling: 105,
    pathExists: () => true,
  })
  assert.ok(failures.some((f) => f.includes("ADR 0063")))
})

test("checkInvariants fails loudly when the map table cannot be parsed", () => {
  const failures = checkInvariants({
    md: "# CLAUDE.md",
    adrNumbers: [1],
    dexieCeiling: 1,
    pathExists: () => true,
  })
  assert.equal(failures.length, 1)
  assert.match(failures[0], /no parseable Subsystem Map/)
})

test("readAdrNumbers and readDexieCeiling read real repo state", () => {
  const adrs = readAdrNumbers()
  assert.ok(adrs.includes(1))
  assert.ok(Math.max(...adrs) >= 66)
  const ceiling = readDexieCeiling()
  assert.ok(ceiling >= 105)
})
