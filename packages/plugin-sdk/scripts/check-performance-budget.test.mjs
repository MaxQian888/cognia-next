import assert from "node:assert/strict"
import { describe, test } from "node:test"

import {
  checkPerformanceBudget,
  percentile,
  resolvePerformanceFiles,
  summarizeLifecycleSamples,
} from "./check-performance-budget.mjs"

const baseline = {
  budgets: { latencyRegressionRatio: 0.05, chunkRegressionRatio: 0.02 },
  lifecycle: {
    boot: { p50Ms: 10, p95Ms: 20 },
    activate: { p50Ms: 30, p95Ms: 40 },
  },
  chunk: { rawBytes: 1000, gzipBytes: 500 },
}

describe("plugin performance budget", () => {
  test("calculates stable nearest-rank percentiles", () => {
    assert.equal(percentile([4, 1, 3, 2], 0.5), 2)
    assert.deepEqual(summarizeLifecycleSamples({ boot: [4, 1, 3, 2] }), {
      boot: { p50Ms: 2, p95Ms: 4 },
    })
  })

  test("accepts measurements at the configured limits", () => {
    assert.deepEqual(
      checkPerformanceBudget(baseline, {
        lifecycle: {
          boot: { p50Ms: 10.5, p95Ms: 21 },
          activate: { p50Ms: 31.5, p95Ms: 42 },
        },
        chunk: { rawBytes: 1020, gzipBytes: 510 },
      }),
      []
    )
  })

  test("reports regressions and missing lifecycle phases", () => {
    assert.deepEqual(
      checkPerformanceBudget(baseline, {
        lifecycle: { boot: { p50Ms: 11, p95Ms: 22 } },
        chunk: { rawBytes: 1021, gzipBytes: 511 },
      }),
      [
        "boot.p50Ms 11ms exceeds 10.500ms",
        "boot.p95Ms 22ms exceeds 21.000ms",
        "missing lifecycle phase activate",
        "chunk.rawBytes 1021 exceeds 1020",
        "chunk.gzipBytes 511 exceeds 510",
      ]
    )
  })

  test("accepts a candidate with the default baseline or an explicit pair", () => {
    assert.deepEqual(resolvePerformanceFiles(["candidate.json"], "/repo", "/default.json"), {
      baselinePath: "/default.json",
      candidatePath: "/repo/candidate.json",
    })
    assert.deepEqual(
      resolvePerformanceFiles(["baseline.json", "candidate.json"], "/repo", "/default.json"),
      {
        baselinePath: "/repo/baseline.json",
        candidatePath: "/repo/candidate.json",
      }
    )
    assert.throws(
      () => resolvePerformanceFiles([], "/repo", "/default.json"),
      /\[baseline\.json\] <candidate\.json>/
    )
  })
})
