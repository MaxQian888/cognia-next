/**
 * Coverage for scripts/ci/report/playwright.mjs.
 *
 * The fixture mirrors the JSON reporter's real shape: nested `suites`, a
 * `specs` array holding `tests`, and per-attempt `results`. Nesting is
 * exercised deliberately — the reporter nests one level per describe block,
 * so a non-recursive walk silently reports zero for most real suites.
 *
 * Run with: node --test scripts/ci/report/playwright.test.mjs
 */

import { test } from "node:test"
import assert from "node:assert/strict"

import {
  diffPlaywright,
  flattenTests,
  isFailure,
  isFlaky,
  summarizePlaywright,
} from "./playwright.mjs"

const REPORT = {
  suites: [
    {
      title: "chat.spec.ts",
      file: "tests/e2e/chat.spec.ts",
      specs: [
        {
          title: "sends a message",
          file: "tests/e2e/chat.spec.ts",
          tests: [
            {
              projectName: "chromium",
              status: "expected",
              results: [{ status: "passed", duration: 1200 }],
            },
          ],
        },
      ],
      suites: [
        {
          title: "with attachments",
          specs: [
            {
              title: "uploads a file",
              file: "tests/e2e/chat.spec.ts",
              tests: [
                {
                  projectName: "chromium",
                  status: "flaky",
                  results: [
                    { status: "failed", duration: 5000, error: { message: "timeout" } },
                    { status: "passed", duration: 900 },
                  ],
                },
              ],
            },
            {
              title: "rejects a huge file",
              file: "tests/e2e/chat.spec.ts",
              tests: [
                {
                  projectName: "chromium",
                  status: "unexpected",
                  results: [
                    { status: "failed", duration: 300, error: { message: "expected 413" } },
                  ],
                },
              ],
            },
          ],
        },
      ],
    },
  ],
}

test("flattenTests walks nested suites and joins the title trail", () => {
  const tests = flattenTests(REPORT)
  assert.equal(tests.length, 3)
  assert.deepEqual(
    tests.map((t) => t.title),
    [
      "chat.spec.ts › sends a message",
      "chat.spec.ts › with attachments › uploads a file",
      "chat.spec.ts › with attachments › rejects a huge file",
    ]
  )
})

test("flattenTests sums the duration of every attempt and keeps the last error", () => {
  const uploads = flattenTests(REPORT)[1]
  assert.equal(uploads.attempts, 2)
  assert.equal(uploads.duration, 5900)
  assert.equal(uploads.error, "")

  const rejects = flattenTests(REPORT)[2]
  assert.equal(rejects.error, "expected 413")
})

test("flattenTests tolerates an empty or malformed report", () => {
  assert.deepEqual(flattenTests({}), [])
  assert.deepEqual(flattenTests(null), [])
  assert.deepEqual(flattenTests({ suites: [{ title: "empty" }] }), [])
})

test("isFlaky trusts Playwright's own status", () => {
  assert.ok(isFlaky({ status: "flaky", attempts: 2 }))
})

test("isFlaky falls back to retried-then-green when status is absent", () => {
  assert.ok(isFlaky({ status: "expected", attempts: 2 }))
  assert.ok(isFlaky({ status: "passed", attempts: 3 }))
})

test("isFlaky does not count a first-try pass or a real failure", () => {
  assert.ok(!isFlaky({ status: "expected", attempts: 1 }))
  assert.ok(!isFlaky({ status: "unexpected", attempts: 2 }))
})

test("isFailure covers the reporter's failure vocabularies", () => {
  assert.ok(isFailure({ status: "unexpected" }))
  assert.ok(isFailure({ status: "failed" }))
  assert.ok(isFailure({ status: "timedOut" }))
  assert.ok(!isFailure({ status: "expected" }))
  assert.ok(!isFailure({ status: "flaky" }))
})

test("summarizePlaywright separates real failures from flakes", () => {
  const summary = summarizePlaywright(REPORT)
  assert.equal(summary.total, 3)
  assert.equal(summary.failed.length, 1)
  assert.equal(summary.failed[0].title, "chat.spec.ts › with attachments › rejects a huge file")
  assert.equal(summary.flaky.length, 1)
  assert.equal(summary.flaky[0].title, "chat.spec.ts › with attachments › uploads a file")
  assert.equal(summary.firstPassRate, 33.33)
  assert.equal(summary.flakyRate, 33.33)
  assert.equal(summary.p95Duration, 5900)
})

test("summarizePlaywright ranks the slowest tests", () => {
  const summary = summarizePlaywright(REPORT, { slowest: 2 })
  assert.deepEqual(
    summary.slowest.map((t) => t.duration),
    [5900, 1200]
  )
})

test("summarizePlaywright copes with no report at all", () => {
  const summary = summarizePlaywright(null)
  assert.equal(summary.total, 0)
  assert.deepEqual(summary.failed, [])
  assert.deepEqual(summary.flaky, [])
  assert.equal(summary.firstPassRate, null)
  assert.equal(summary.flakyRate, null)
  assert.equal(summary.p95Duration, 0)
})

test("diffPlaywright reports first-pass, flaky, and P95 changes", () => {
  // Both runs ran the same two tests. In the baseline one of them failed its
  // first attempt and was retried green (flaky); in this run both passed
  // first time and the slow one got faster.
  const ids = [
    { file: "a.spec.ts", title: "one", project: "chromium" },
    { file: "b.spec.ts", title: "two", project: "chromium" },
  ]
  const trend = diffPlaywright(
    {
      tests: [
        {
          ...ids[0],
          firstAttemptStatus: "passed",
          status: "expected",
          attempts: 1,
          duration: 1000,
        },
        {
          ...ids[1],
          firstAttemptStatus: "passed",
          status: "expected",
          attempts: 1,
          duration: 40_000,
        },
      ],
    },
    {
      tests: [
        {
          ...ids[0],
          firstAttemptStatus: "passed",
          status: "expected",
          attempts: 1,
          duration: 1000,
        },
        {
          ...ids[1],
          firstAttemptStatus: "failed",
          status: "expected",
          attempts: 2,
          duration: 45_000,
        },
      ],
    }
  )

  assert.equal(trend.hasBase, true)
  assert.equal(trend.comparedTests, 2)
  assert.deepEqual(trend.metrics, [
    { key: "firstPassRate", from: 50, to: 100, delta: 50 },
    { key: "flakyRate", from: 50, to: 0, delta: -50 },
    { key: "p95Duration", from: 45_000, to: 40_000, delta: -5000 },
  ])
})

test("diffPlaywright declines a trend when an artifact predates per-test detail", () => {
  // Old baseline artifacts carry only the aggregates. Comparing those is the
  // defect this intersection exists to prevent, so no trend is better.
  const trend = diffPlaywright(
    { firstPassRate: 99, flakyRate: 0.5, p95Duration: 40_000, tests: [] },
    { firstPassRate: 98, flakyRate: 1, p95Duration: 45_000 }
  )
  assert.equal(trend.hasBase, false)
  assert.equal(trend.reason, "no-test-detail")
})

test("diffPlaywright remains useful without a baseline", () => {
  const current = { firstPassRate: 99, flakyRate: 0.5, p95Duration: 40_000 }
  assert.deepEqual(diffPlaywright(current, null), { hasBase: false, current })
})

test("diffPlaywright compares only the tests both runs actually ran", () => {
  // The PR gate runs `--grep "@smoke|@critical|@a11y|@visual"`; the trunk
  // baseline runs the full suite. Comparing their aggregates compares
  // different populations, and the bias is systematic: the full run carries
  // the slow and flaky specs the gate never executes, so every PR looks like
  // an improvement.
  const tagged = { file: "a.spec.ts", title: "tagged", project: "chromium" }
  const untagged = { file: "b.spec.ts", title: "untagged", project: "chromium" }

  const current = {
    firstPassRate: 100,
    flakyRate: 0,
    p95Duration: 1000,
    tests: [
      { ...tagged, firstAttemptStatus: "passed", status: "expected", attempts: 1, duration: 1000 },
    ],
  }
  const base = {
    firstPassRate: 50,
    flakyRate: 50,
    p95Duration: 9000,
    tests: [
      { ...tagged, firstAttemptStatus: "passed", status: "expected", attempts: 1, duration: 1000 },
      {
        ...untagged,
        firstAttemptStatus: "failed",
        status: "expected",
        attempts: 2,
        duration: 9000,
      },
    ],
  }

  const trend = diffPlaywright(current, base)
  assert.equal(trend.hasBase, true)
  // Restricted to the one test both runs ran, nothing changed.
  assert.deepEqual(trend.metrics, [
    { key: "firstPassRate", from: 100, to: 100, delta: 0 },
    { key: "flakyRate", from: 0, to: 0, delta: 0 },
    { key: "p95Duration", from: 1000, to: 1000, delta: 0 },
  ])
  assert.equal(trend.comparedTests, 1)
  assert.equal(trend.baseOnlyTests, 1)
  assert.equal(trend.currentOnlyTests, 0)
})

test("diffPlaywright reports no trend when the two runs share no tests", () => {
  const current = {
    firstPassRate: 100,
    flakyRate: 0,
    p95Duration: 1,
    tests: [
      {
        file: "a.spec.ts",
        title: "x",
        project: "chromium",
        firstAttemptStatus: "passed",
        attempts: 1,
        duration: 1,
      },
    ],
  }
  const base = {
    firstPassRate: 10,
    flakyRate: 90,
    p95Duration: 9,
    tests: [
      {
        file: "z.spec.ts",
        title: "y",
        project: "firefox",
        firstAttemptStatus: "failed",
        attempts: 1,
        duration: 9,
      },
    ],
  }
  const trend = diffPlaywright(current, base)
  assert.equal(trend.hasBase, false)
  assert.equal(trend.reason, "no-overlap")
})

test("diffPlaywright distinguishes same-titled tests in different projects", () => {
  const shared = { file: "a.spec.ts", title: "same title" }
  const current = {
    firstPassRate: 0,
    flakyRate: 0,
    p95Duration: 0,
    tests: [
      { ...shared, project: "chromium", firstAttemptStatus: "passed", attempts: 1, duration: 100 },
    ],
  }
  const base = {
    firstPassRate: 0,
    flakyRate: 0,
    p95Duration: 0,
    tests: [
      { ...shared, project: "firefox", firstAttemptStatus: "passed", attempts: 1, duration: 100 },
    ],
  }
  assert.equal(diffPlaywright(current, base).hasBase, false)
})
