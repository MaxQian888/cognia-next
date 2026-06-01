/**
 * Eval run controller — the action layer the UI calls to run a dataset.
 *
 * Loads the dataset + cases, runs the engine ({@link runDatasetEval}), and
 * persists the resulting {@link EvalReport}. Dependency-injected (db loaders,
 * saver, scorers, target, clock, id) so it is fully unit-testable without
 * Dexie or a sidecar. {@link buildDefaultRunControllerDeps} wires the real
 * Dexie CRUD + chat target for the dashboard.
 */

import type { EvalCase, EvalDataset, EvalReport, Scorer } from "@/types/eval/eval"
import { runDatasetEval } from "./index"
import type { EvalTarget, RunEvalOptions } from "./runner"

export interface RunControllerDeps {
  loadDataset(id: string): Promise<EvalDataset | undefined>
  loadCases(datasetId: string): Promise<EvalCase[]>
  saveRun(report: EvalReport): Promise<void>
  scorers: Scorer[]
  target: EvalTarget
  now(): number
  newRunId(): string
}

export interface RunDatasetOptions {
  k?: number
  signal?: AbortSignal
  onCaseComplete?: RunEvalOptions["onCaseComplete"]
}

export async function runDatasetById(
  datasetId: string,
  deps: RunControllerDeps,
  options: RunDatasetOptions = {}
): Promise<EvalReport> {
  const dataset = await deps.loadDataset(datasetId)
  if (!dataset) throw new Error(`runDatasetById: dataset "${datasetId}" not found`)
  const cases = await deps.loadCases(datasetId)
  const { report } = await runDatasetEval({
    dataset,
    cases,
    scorers: deps.scorers,
    target: deps.target,
    runId: deps.newRunId(),
    now: deps.now(),
    ...(options.k ? { k: options.k } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.onCaseComplete ? { onCaseComplete: options.onCaseComplete } : {}),
  })
  await deps.saveRun(report)
  return report
}
