/**
 * Agent eval engine — public barrel + the `runDatasetEval` convenience that
 * ties a dataset → {@link runEval} → {@link buildReport} together. Persistence
 * stays out of here (callers `saveRun` the returned report) so the engine has
 * no Dexie dependency and stays trivially testable. Timestamp + runId are
 * injected for the same reason.
 */

import type { EvalCase, EvalCaseResult, EvalDataset, EvalReport, Scorer } from "@/types/eval/eval"
import { runEval, type EvalTarget, type RunEvalOptions } from "./runner"
import { buildReport } from "./report"

export { runEval, type EvalTarget, type RunEvalOptions } from "./runner"
export { buildReport, type BuildReportInput } from "./report"
export {
  assembleSampleFromSpans,
  createChatTarget,
  defaultChatTargetDeps,
  type ChatTargetConfig,
  type ChatTargetDeps,
} from "./target"
export * from "./scorers"

export interface RunDatasetEvalInput {
  dataset: EvalDataset
  cases: EvalCase[]
  scorers: Scorer[]
  target: EvalTarget
  runId: string
  /** Injected timestamp for the report's createdAt. */
  now: number
  k?: number
  signal?: AbortSignal
  onCaseComplete?: RunEvalOptions["onCaseComplete"]
}

export async function runDatasetEval(
  input: RunDatasetEvalInput
): Promise<{ report: EvalReport; results: EvalCaseResult[] }> {
  const k = Math.max(1, Math.floor(input.k ?? 1))
  const results = await runEval({
    cases: input.cases,
    scorers: input.scorers,
    target: input.target,
    k,
    ...(input.signal ? { signal: input.signal } : {}),
    ...(input.onCaseComplete ? { onCaseComplete: input.onCaseComplete } : {}),
  })
  const report = buildReport({
    runId: input.runId,
    datasetId: input.dataset.id,
    datasetVersion: input.dataset.version,
    targetLabel: input.target.label,
    k,
    results,
    createdAt: input.now,
  })
  return { report, results }
}
