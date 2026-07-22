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

import { flattenTests, isFailure, isFlaky, summarizePlaywright } from "./playwright.mjs"

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
})
