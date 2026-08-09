/**
 * Coverage for scripts/test/coverage-ratchet.mjs.
 *
 * The interesting logic is the proposal rule — when NOT to recommend is as
 * important as when to. A floor proposed above the measured value would fail
 * the very next run, and Jest's negative "max uncovered count" thresholds are
 * a different unit that must never be touched.
 *
 * Run with: node --test scripts/test/coverage-ratchet.test.mjs
 */

import { test } from "node:test"
import assert from "node:assert/strict"

import {
  DEFAULT_SLACK,
  METRICS,
  TARGET,
  applyRecommendations,
  measureGroups,
  parseArgs,
  proposeFloor,
  recommend,
} from "./coverage-ratchet.mjs"

function istanbul(path, count, hit) {
  const statementMap = {}
  const s = {}
  for (let i = 0; i < count; i += 1) {
    statementMap[i] = { start: { line: i + 1, column: 0 }, end: { line: i + 1, column: 1 } }
    s[i] = i < hit ? 1 : 0
  }
  return { [path]: { path, statementMap, s, fnMap: {}, f: {}, branchMap: {}, b: {} } }
}

test("parseArgs defaults, overrides and rejects junk", () => {
  assert.deepEqual(parseArgs([]), {
    coverage: "coverage/coverage-final.json",
    write: false,
    slack: DEFAULT_SLACK,
  })
  assert.equal(parseArgs(["--coverage", "c.json"]).coverage, "c.json")
  assert.equal(parseArgs(["--write"]).write, true)
  assert.equal(parseArgs(["--slack", "2"]).slack, 2)
  assert.throws(() => parseArgs(["--coverage"]), /argument missing/i)
  assert.throws(() => parseArgs(["--slack", "abc"]), /requires a number/)
  assert.throws(() => parseArgs(["--nope"]), /unknown option/i)
})

test("proposeFloor raises a floor that has real headroom", () => {
  assert.equal(proposeFloor(25, 42.9), 42)
})

test("proposeFloor rounds down, never above what was measured", () => {
  // A floor at the measured value's ceiling would fail the next run.
  assert.equal(proposeFloor(30, 40.99), 40)
})

test("proposeFloor declines when the headroom is inside the slack band", () => {
  assert.equal(proposeFloor(40, 44), null)
  assert.equal(proposeFloor(40, 44.9, 5), null)
  assert.equal(proposeFloor(40, 45, 5), 45)
})

test("proposeFloor never exceeds the CLAUDE.md target", () => {
  assert.equal(proposeFloor(50, 99.9), TARGET)
  assert.equal(proposeFloor(TARGET, 99.9), null)
})

test("proposeFloor leaves Jest's negative max-uncovered thresholds alone", () => {
  assert.equal(proposeFloor(-20, 95), null)
})

test("proposeFloor tolerates an unmeasured metric", () => {
  assert.equal(proposeFloor(50, null), null)
  assert.equal(proposeFloor(50, undefined), null)
})

test("recommend walks every group/metric pair and skips unmeasured groups", () => {
  const thresholds = {
    "./lib/**": { lines: 75, branches: 50 },
    "./absent/**": { lines: 10 },
  }
  const measured = { "./lib/**": { lines: 88.5, branches: 51 } }
  assert.deepEqual(recommend(thresholds, measured), [
    { group: "./lib/**", metric: "lines", from: 75, to: 88, measured: 88.5 },
  ])
})

test("recommend returns nothing when every floor is already tight", () => {
  assert.deepEqual(recommend({ global: { lines: 25 } }, { global: { lines: 26 } }), [])
})

test("applyRecommendations returns a new object and leaves the input untouched", () => {
  const thresholds = { global: { lines: 25, branches: 60 } }
  const next = applyRecommendations(thresholds, [
    { group: "global", metric: "lines", from: 25, to: 40 },
  ])
  assert.equal(next.global.lines, 40)
  assert.equal(next.global.branches, 60)
  assert.equal(thresholds.global.lines, 25, "the original must not be mutated")
})

test("measureGroups computes per-group percentages from a merged map", () => {
  const thresholds = { global: { lines: 25 } }
  const measured = measureGroups(istanbul("/repo/lib/a.ts", 10, 6), thresholds, { cwd: "/repo" })
  assert.equal(measured.global.statements, 60)
  assert.equal(measured.global.lines, 60)
})

test("measureGroups reports null for a metric with no data at all", () => {
  const measured = measureGroups(istanbul("/repo/lib/a.ts", 4, 4), { global: {} }, { cwd: "/repo" })
  assert.equal(measured.global.branches, null)
})

test("measureGroups omits groups that matched no files", () => {
  const thresholds = { "./nothing-here/**": { lines: 10 } }
  const measured = measureGroups(istanbul("/repo/lib/a.ts", 2, 1), thresholds, { cwd: "/repo" })
  assert.equal(measured["./nothing-here/**"], undefined)
})

test("METRICS covers the four istanbul metrics", () => {
  assert.deepEqual([...METRICS].sort(), ["branches", "functions", "lines", "statements"])
})
