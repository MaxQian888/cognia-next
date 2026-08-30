/**
 * CI eval gate (`pnpm test:evals`). Re-scores the checked-in golden
 * trajectories with the deterministic tier and asserts the configured
 * thresholds hold — a fast, model-free regression gate that catches scorer (or
 * reference) regressions before merge.
 */

import type { EvalCaseResult } from "@/types/eval/eval"
import { GOLDEN_ENTRIES } from "./golden-fixture"
import { deterministicScorers } from "@cognia/eval-core"
import { buildReport } from "@cognia/eval-core"
import { evaluateGate } from "@cognia/eval-core"

async function scoreGolden(): Promise<EvalCaseResult[]> {
  const scorers = deterministicScorers()
  const results: EvalCaseResult[] = []
  for (const entry of GOLDEN_ENTRIES) {
    const scores = await Promise.all(scorers.map((s) => s.score(entry.sample, entry.case)))
    results.push({ caseId: entry.case.id, repetitions: [{ sample: entry.sample, scores }] })
  }
  return results
}

describe("golden regression gate", () => {
  it("every golden trajectory passes all applicable deterministic scorers", async () => {
    const results = await scoreGolden()
    const report = buildReport({
      runId: "ci-golden",
      datasetId: "golden",
      datasetVersion: 1,
      targetLabel: "golden",
      k: 1,
      results,
      createdAt: 0,
    })

    const gate = evaluateGate(report, {
      minPassHatK: 1,
      minPassAt1: 1,
      minScorerPassRate: 1,
    })

    // Surface the exact breach in CI output before asserting.
    if (!gate.passed) throw new Error(`eval gate failed:\n${gate.failures.join("\n")}`)
    expect(gate.passed).toBe(true)
    expect(report.caseCount).toBe(GOLDEN_ENTRIES.length)
  })
})
