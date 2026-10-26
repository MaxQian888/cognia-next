/**
 * The plugin contract's share of `lib/ai/eval/service.ts`, which re-exports these.
 */
export interface EvalDatasetSummary {
  id: string
  name: string
  capability: string
  version: number
  caseCount: number
  latestRun?: { runId: string; passAt1: number; createdAt: number; targetLabel: string }
}

export interface EvalRunDetail {
  report: import("../../db/eval-runs").EvalRunRow
  cases: import("../../db/eval-run-cases").EvalRunCaseRow[]
}
