/**
 * Coverage for scripts/ci/report/coverage.mjs.
 *
 * The fixtures are real istanbul file-coverage objects (statementMap / s /
 * fnMap / f / branchMap / b), not hand-rolled summaries, so the module is
 * pinned against the shape jest actually writes to coverage-final.json.
 *
 * Run with: node --test scripts/ci/report/coverage.test.mjs
 */

import { test } from "node:test"
import assert from "node:assert/strict"

import { METRICS, diffCoverage, regressions, summarizeCoverage } from "./coverage.mjs"

/**
 * Build a one-file istanbul map with `hit` of `count` statements covered.
 */
function fileCoverage(path, count, hit) {
  const statementMap = {}
  const s = {}
  for (let i = 0; i < count; i += 1) {
    statementMap[i] = { start: { line: i + 1, column: 0 }, end: { line: i + 1, column: 10 } }
    s[i] = i < hit ? 1 : 0
  }
  return {
    [path]: {
      path,
      statementMap,
      s,
      fnMap: { 0: { name: "f", decl: {}, loc: {}, line: 1 } },
      f: { 0: hit > 0 ? 1 : 0 },
      branchMap: {},
      b: {},
    },
  }
}

test("METRICS lists the four istanbul metrics", () => {
  assert.deepEqual(METRICS, ["lines", "statements", "functions", "branches"])
})

test("summarizeCoverage turns a raw map into covered/total/pct per metric", () => {
  const summary = summarizeCoverage(fileCoverage("/repo/lib/a.ts", 10, 7))
  assert.equal(summary.files, 1)
  assert.equal(summary.metrics.statements.total, 10)
  assert.equal(summary.metrics.statements.covered, 7)
  assert.equal(summary.metrics.statements.pct, 70)
  assert.equal(summary.metrics.functions.pct, 100)
})

test("summarizeCoverage reports null rather than a misleading 100% for empty metrics", () => {
  // No branches exist in the fixture; istanbul would call that 100%.
  const summary = summarizeCoverage(fileCoverage("/repo/lib/a.ts", 4, 4))
  assert.equal(summary.metrics.branches.total, 0)
  assert.equal(summary.metrics.branches.pct, null)
})

test("summarizeCoverage handles an empty or missing map", () => {
  assert.equal(summarizeCoverage({}).files, 0)
  assert.equal(summarizeCoverage(null).files, 0)
  assert.equal(summarizeCoverage({}).metrics.lines.pct, null)
})

test("diffCoverage computes signed deltas against the base", () => {
  const base = summarizeCoverage(fileCoverage("/repo/lib/a.ts", 10, 5))
  const current = summarizeCoverage(fileCoverage("/repo/lib/a.ts", 10, 8))
  const diff = diffCoverage(current, base)

  assert.equal(diff.hasBase, true)
  const statements = diff.metrics.find((m) => m.key === "statements")
  assert.equal(statements.from, 50)
  assert.equal(statements.to, 80)
  assert.equal(statements.delta, 30)
})

test("diffCoverage says so when there is no baseline", () => {
  const diff = diffCoverage(summarizeCoverage(fileCoverage("/repo/lib/a.ts", 2, 1)), null)
  assert.equal(diff.hasBase, false)
  assert.deepEqual(diff.metrics, [])
})

test("diffCoverage leaves the delta null when either side is unknown", () => {
  const base = summarizeCoverage({})
  const current = summarizeCoverage(fileCoverage("/repo/lib/a.ts", 2, 1))
  const lines = diffCoverage(current, base).metrics.find((m) => m.key === "lines")
  assert.equal(lines.from, null)
  assert.equal(lines.delta, null)
})

test("regressions reports a real drop", () => {
  const base = summarizeCoverage(fileCoverage("/repo/lib/a.ts", 10, 9))
  const current = summarizeCoverage(fileCoverage("/repo/lib/a.ts", 10, 4))
  const dropped = regressions(diffCoverage(current, base))
  assert.ok(dropped.some((m) => m.key === "statements"))
  assert.equal(dropped.find((m) => m.key === "statements").delta, -50)
})

test("regressions ignores sub-tolerance noise and improvements", () => {
  const base = summarizeCoverage(fileCoverage("/repo/lib/a.ts", 1000, 900))
  const current = summarizeCoverage(fileCoverage("/repo/lib/a.ts", 1000, 899))
  assert.deepEqual(regressions(diffCoverage(current, base), 0.5), [])

  const better = summarizeCoverage(fileCoverage("/repo/lib/a.ts", 1000, 950))
  assert.deepEqual(regressions(diffCoverage(better, base)), [])
})

test("regressions is empty without a baseline", () => {
  assert.deepEqual(regressions({ hasBase: false, metrics: [] }), [])
})
