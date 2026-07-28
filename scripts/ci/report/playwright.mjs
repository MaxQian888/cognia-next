#!/usr/bin/env node
/**
 * Playwright results → failures and flakes.
 *
 * `playwright.config.ts` sets `retries: 1` in CI, so a test that fails once
 * and passes on the retry is reported green and disappears. That is exactly
 * the signal worth keeping: a flake is a bug that has not been diagnosed yet.
 * Nothing read the retry data before.
 *
 * Input is the JSON reporter's output (`playwright merge-reports --reporter
 * json`), which nests suites arbitrarily deep, so the walk is recursive.
 *
 * Scope note: this reports flakes for a SINGLE run. Cross-run flake trends
 * need somewhere to persist history, which the report pipeline deliberately
 * does not have — it reads the trunk branch's last successful artifacts and
 * writes nothing.
 */

/**
 * Flatten the nested suite tree into one test record per spec/test. Pure.
 *
 * @param {object} report parsed JSON reporter output
 * @returns {Array<{ file: string, title: string, project: string, status: string, firstAttemptStatus: string, attempts: number, duration: number, error: string }>}
 */
export function flattenTests(report) {
  const out = []

  const visitSuite = (suite, trail) => {
    const path = suite.title ? [...trail, suite.title] : trail
    for (const spec of suite.specs ?? []) {
      for (const test of spec.tests ?? []) {
        const results = test.results ?? []
        const last = results[results.length - 1]
        out.push({
          file: spec.file ?? suite.file ?? "",
          title: [...path, spec.title].filter(Boolean).join(" › "),
          project: test.projectName ?? test.projectId ?? "",
          status: test.status ?? last?.status ?? "unknown",
          firstAttemptStatus: results[0]?.status ?? "unknown",
          attempts: results.length,
          duration: results.reduce((n, r) => n + (r.duration ?? 0), 0),
          error: last?.error?.message ?? "",
        })
      }
    }
    for (const child of suite.suites ?? []) visitSuite(child, path)
  }

  for (const suite of report?.suites ?? []) visitSuite(suite, [])
  return out
}

/**
 * A test is flaky when it needed more than one attempt but ended up green.
 * Pure.
 *
 * Playwright's own `status: "flaky"` is trusted when present; the attempt
 * analysis is the fallback for reporter versions that omit it.
 */
export function isFlaky(test) {
  if (test.status === "flaky") return true
  return test.attempts > 1 && (test.status === "expected" || test.status === "passed")
}

/** Pure. */
export function isFailure(test) {
  return test.status === "unexpected" || test.status === "failed" || test.status === "timedOut"
}

/**
 * Summarize a merged Playwright report. Pure.
 *
 * @param {object} report
 * @param {{ slowest?: number }} [options]
 */
export function summarizePlaywright(report, options = {}) {
  const slowestCount = options.slowest ?? 10
  const tests = flattenTests(report)
  const flaky = tests.filter(isFlaky)
  const durations = tests.map((test) => test.duration).sort((a, b) => a - b)
  const percentage = (count) =>
    tests.length === 0 ? null : Number(((count / tests.length) * 100).toFixed(2))
  return {
    total: tests.length,
    failed: tests.filter(isFailure),
    flaky,
    skipped: tests.filter((t) => t.status === "skipped").length,
    firstPassRate: percentage(tests.filter((test) => test.firstAttemptStatus === "passed").length),
    flakyRate: percentage(flaky.length),
    p95Duration:
      durations.length === 0 ? 0 : durations[Math.max(0, Math.ceil(durations.length * 0.95) - 1)],
    slowest: [...tests].sort((a, b) => b.duration - a.duration).slice(0, slowestCount),
  }
}

/** Compare the health metrics from this run with the latest green trunk run. Pure. */
export function diffPlaywright(current, base) {
  if (!base) return { hasBase: false, current }
  const keys = ["firstPassRate", "flakyRate", "p95Duration"]
  return {
    hasBase: true,
    metrics: keys.map((key) => ({
      key,
      from: base[key],
      to: current[key],
      delta:
        current[key] === null || base[key] === null
          ? null
          : Number(current[key]) - Number(base[key]),
    })),
  }
}
