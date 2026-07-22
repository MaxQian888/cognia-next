#!/usr/bin/env node
/**
 * Coverage totals and trunk-relative deltas for the CI report.
 *
 * `scripts/test/merge-coverage.mjs` already merges the shard maps and
 * enforces the layered thresholds; this module answers the other question —
 * "did this change move coverage, and which way" — which nothing did before.
 *
 * Uses `istanbul-lib-coverage`, the same library merge-coverage.mjs already
 * depends on, so the numbers here are the same numbers the gate sees rather
 * than a second, subtly different calculation.
 */

import libCoverage from "istanbul-lib-coverage"

export const METRICS = ["lines", "statements", "functions", "branches"]

/**
 * Reduce a raw istanbul coverage map into percentage totals. Pure.
 *
 * @param {object} rawMap contents of a coverage-final.json
 * @returns {{ files: number, metrics: Record<string, { covered: number, total: number, pct: number }> }}
 */
export function summarizeCoverage(rawMap) {
  const map = libCoverage.createCoverageMap(rawMap ?? {})
  const summary = map.getCoverageSummary()
  const metrics = {}
  for (const metric of METRICS) {
    const m = summary[metric]
    metrics[metric] = {
      covered: m.covered,
      total: m.total,
      // istanbul reports pct as 100 when total is 0; "unknown" is more
      // honest for a report a human reads.
      pct: m.total === 0 ? null : Number(m.pct.toFixed(2)),
    }
  }
  return { files: map.files().length, metrics }
}

/**
 * Compare two summaries. Pure. `base` may be null on a first run.
 *
 * @param {ReturnType<typeof summarizeCoverage>} current
 * @param {ReturnType<typeof summarizeCoverage> | null} base
 */
export function diffCoverage(current, base) {
  if (!base) return { hasBase: false, current, metrics: [] }
  const metrics = METRICS.map((key) => {
    const from = base.metrics[key]?.pct ?? null
    const to = current.metrics[key]?.pct ?? null
    const delta = from === null || to === null ? null : Number((to - from).toFixed(2))
    return { key, from, to, delta }
  })
  return { hasBase: true, current, base, metrics }
}

/**
 * Did coverage drop on any metric? Pure.
 *
 * Reported, never enforced: the merged-threshold gate and the changed-files
 * gate are what block. A percentage can dip legitimately — deleting a
 * well-covered module raises the share of uncovered code without anyone
 * writing a worse line.
 *
 * @param {ReturnType<typeof diffCoverage>} diff
 * @param {number} [tolerance] percentage points of noise to ignore
 */
export function regressions(diff, tolerance = 0.1) {
  if (!diff.hasBase) return []
  return diff.metrics.filter((m) => m.delta !== null && m.delta < -tolerance)
}
