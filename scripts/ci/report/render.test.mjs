/**
 * Coverage for scripts/ci/report/render.mjs.
 *
 * The behaviour worth pinning is the degradation: every section must say
 * something explicit when its producer did not run, because a silently
 * missing section reads as "all clear".
 *
 * Run with: node --test scripts/ci/report/render.test.mjs
 */

import { test } from "node:test"
import assert from "node:assert/strict"

import {
  COMMENT_MARKER,
  oneLine,
  renderBundle,
  renderCoverage,
  renderJest,
  renderPlaywright,
  renderReport,
  truncate,
} from "./render.mjs"

const JEST = {
  total: 12,
  passed: 10,
  skipped: 1,
  suites: 4,
  totalTime: 31.5,
  failed: [{ suite: "lib/a.test.ts", name: "does a thing", message: "expected 1\n  to equal 2" }],
  slowest: [{ suite: "lib/slow.test.ts", time: 20, tests: 3 }],
}

const PW = {
  total: 5,
  skipped: 1,
  failed: [{ file: "tests/e2e/a.spec.ts", title: "x › y", project: "chromium", error: "boom" }],
  flaky: [{ file: "tests/e2e/b.spec.ts", title: "retried", project: "chromium", attempts: 2 }],
  slowest: [],
}

test("truncate keeps the head and counts the tail honestly", () => {
  assert.deepEqual(truncate([1, 2, 3], 5), { shown: [1, 2, 3], hidden: 0 })
  assert.deepEqual(truncate([1, 2, 3, 4], 2), { shown: [1, 2], hidden: 2 })
})

test("oneLine flattens whitespace and elides overlong text", () => {
  assert.equal(oneLine("a\n  b\tc "), "a b c")
  assert.equal(oneLine("x".repeat(20), 10), `${"x".repeat(9)}…`)
  assert.equal(oneLine(undefined), "")
})

test("renderJest lists failures with their message", () => {
  const md = renderJest(JEST).join("\n")
  assert.match(md, /\*\*10\*\* passed/)
  assert.match(md, /`lib\/a\.test\.ts` › does a thing/)
  assert.match(md, /expected 1 to equal 2/)
  assert.match(md, /Slowest suites/)
})

test("renderJest says so when there is no JUnit output at all", () => {
  assert.match(renderJest(undefined).join("\n"), /No JUnit output found/)
})

test("renderPlaywright separates failures from flakes in the output", () => {
  const md = renderPlaywright({
    ...PW,
    firstPassRate: 99.25,
    flakyRate: 0.25,
    p95Duration: 42_000,
    trend: {
      hasBase: true,
      metrics: [
        { key: "firstPassRate", from: 98, to: 99.25, delta: 1.25 },
        { key: "flakyRate", from: 1, to: 0.25, delta: -0.75 },
        { key: "p95Duration", from: 50_000, to: 42_000, delta: -8000 },
      ],
    },
  }).join("\n")
  assert.match(md, /\*\*1\*\* failed/)
  assert.match(md, /\*\*1\*\* flaky/)
  assert.match(md, /Flaky — passed only on retry/)
  assert.match(md, /`tests\/e2e\/b\.spec\.ts` › retried \(2 attempts\)/)
  assert.match(md, /First-pass 99\.25%/)
  assert.match(md, /Flaky rate 0\.25%/)
  assert.match(md, /P95 42\.0s/)
  assert.match(md, /\| First-pass rate \| 98\.00% \| 99\.25% \| \+1\.25 \|/)
  assert.match(md, /\| P95 duration \| 50\.0s \| 42\.0s \| -8\.0s \|/)
})

test("renderPlaywright says so when the report is missing", () => {
  assert.match(renderPlaywright(null).join("\n"), /No Playwright report found/)
})

test("renderCoverage renders a delta table when a base exists", () => {
  const md = renderCoverage({
    hasBase: true,
    metrics: [
      { key: "lines", from: 40, to: 42.5, delta: 2.5 },
      { key: "branches", from: 50, to: 48, delta: -2 },
      { key: "functions", from: 30, to: 30, delta: 0 },
      { key: "statements", from: null, to: null, delta: null },
    ],
  }).join("\n")
  assert.match(md, /\| lines \| 40\.00% \| 42\.50% \| 🔼 \+2\.50 \|/)
  assert.match(md, /🔽 -2\.00/)
  assert.match(md, /±0\.00/)
  assert.match(md, /\| statements \| — \| — \| — \|/)
})

test("renderCoverage falls back to absolute values without a base", () => {
  const md = renderCoverage({
    hasBase: false,
    current: { metrics: { lines: { pct: 42.5 }, branches: { pct: null } } },
  }).join("\n")
  assert.match(md, /No baseline run on the trunk branch/)
  assert.match(md, /\| lines \| 42\.50% \|/)
  assert.match(md, /\| branches \| — \|/)
})

test("renderBundle renders byte deltas with percentages", () => {
  const md = renderBundle({
    hasBase: true,
    current: {},
    metrics: [
      { key: "totalBytes", from: 1024, to: 2048, delta: 1024, percent: 100 },
      { key: "fileCount", from: 10, to: 9, delta: -1, percent: -10 },
      { key: "cssBytes", from: 0, to: 50, delta: 50, percent: null },
    ],
  }).join("\n")
  assert.match(md, /\| totalBytes \| 1\.0 KB \| 2\.0 KB \| 1\.0 KB \(\+100\.0%\) \|/)
  assert.match(md, /\| fileCount \| 10 \| 9 \| -1 \(-10\.0%\) \|/)
  // A zero baseline must not render as Infinity%.
  assert.match(md, /\| cssBytes \| 0 B \| 50 B \| 50 B \|/)
})

test("renderBundle says so when the build produced nothing", () => {
  assert.match(renderBundle(null).join("\n"), /produced no measurement/)
})

test("renderReport carries the marker so the comment can be updated in place", () => {
  const md = renderReport({ jest: JEST })
  assert.ok(md.startsWith(COMMENT_MARKER))
  assert.match(md, /## CI report/)
})

test("renderReport includes the run metadata when supplied", () => {
  const md = renderReport({
    meta: { sha: "abcdef1234567890", runUrl: "https://example.test/run/1", conclusion: "failure" },
  })
  assert.match(md, /\*\*failure\*\*/)
  assert.match(md, /commit `abcdef1`/)
  assert.match(md, /\[run log\]\(https:\/\/example\.test\/run\/1\)/)
})

test("renderReport degrades every section rather than dropping it", () => {
  const md = renderReport({})
  assert.match(md, /No JUnit output found/)
  assert.match(md, /No Playwright report found/)
  assert.match(md, /No coverage data in this run/)
  assert.match(md, /produced no measurement/)
})

test("renderReport collapses blank-line runs and ends with exactly one newline", () => {
  const md = renderReport({ jest: JEST, playwright: PW })
  assert.ok(!/\n{3,}/.test(md))
  assert.ok(md.endsWith("\n"))
  assert.ok(!md.endsWith("\n\n"))
})
