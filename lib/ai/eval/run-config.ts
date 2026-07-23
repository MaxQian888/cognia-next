/**
 * Configured matrix runner — expands an {@link EvalRunConfig} (targets ×
 * scorer-subset × k × case-subset) into one pinned {@link EvalReport} per
 * target variant.
 *
 * Flow: snapshot the dataset version ONCE (Approach A), resolve the case
 * subset, then for each target run the engine, persisting the report (tagged
 * with `datasetVersionId` + a config summary) and a compact per-case verdict
 * row per case (feeding the comparison grid). Dependency-injected so it is
 * unit-testable without Dexie / a sidecar.
 */

import type { EvalCase, EvalDataset, EvalReport, Scorer } from "@/types/eval/eval"
import type { EvalDatasetVersion } from "@/types/eval/version"
import type { EvalRunConfig, TargetSpec, CaseSubset } from "@/types/eval/run-config"
import type { SaveCaseResultInput } from "@/lib/db/eval-run-cases"
import { runDatasetEval } from "./index"
import { repetitionVerdict } from "./report"
import { selectScorers } from "./scorer-select"
import type { EvalTarget } from "./runner"

export interface RunConfiguredDeps {
  loadDataset(id: string): Promise<EvalDataset | undefined>
  loadCases(datasetId: string): Promise<EvalCase[]>
  snapshot(datasetId: string): Promise<EvalDatasetVersion>
  buildTarget(spec: TargetSpec): EvalTarget
  allScorers: Scorer[]
  saveRun(report: EvalReport): Promise<void>
  saveCaseResult(row: SaveCaseResultInput): Promise<void>
  now(): number
  newRunId(): string
}

/** Apply a case subset (AND-combined). Undefined subset → all cases. */
export function filterCases(cases: EvalCase[], subset?: CaseSubset): EvalCase[] {
  if (!subset) return cases
  const ids = subset.caseIds && subset.caseIds.length > 0 ? new Set(subset.caseIds) : undefined
  const caps =
    subset.capabilities && subset.capabilities.length > 0 ? new Set(subset.capabilities) : undefined
  const modes =
    subset.failureModes && subset.failureModes.length > 0 ? new Set(subset.failureModes) : undefined
  return cases.filter((c) => {
    if (subset.split && c.split !== subset.split) return false
    if (caps && !caps.has(c.capability)) return false
    if (modes && (!c.failureMode || !modes.has(c.failureMode))) return false
    if (ids && !ids.has(c.id)) return false
    return true
  })
}

export async function runConfiguredEval(
  datasetId: string,
  config: EvalRunConfig,
  deps: RunConfiguredDeps,
  signal?: AbortSignal
): Promise<EvalReport[]> {
  const dataset = await deps.loadDataset(datasetId)
  if (!dataset) throw new Error(`runConfiguredEval: dataset "${datasetId}" not found`)
  const version = await deps.snapshot(datasetId)
  const allCases = await deps.loadCases(datasetId)
  const cases = filterCases(allCases, config.subset)
  const k = Math.max(1, Math.floor(config.k || 1))
  const scorers = selectScorers(deps.allScorers, config.scorerIds)

  const reports: EvalReport[] = []
  for (const spec of config.targets) {
    const target = deps.buildTarget(spec)
    const runId = deps.newRunId()
    const { report } = await runDatasetEval({
      dataset,
      cases,
      scorers,
      target,
      runId,
      now: deps.now(),
      k,
      ...(signal ? { signal } : {}),
      onCaseComplete: (result) => {
        const rep0 = result.repetitions[0]
        if (!rep0) return
        const scores: SaveCaseResultInput["scores"] = {}
        for (const s of rep0.scores) {
          scores[s.scorerId] = {
            value: s.value,
            passed: s.passed,
            status: s.status,
            ...(s.reasoning ? { reasoning: s.reasoning } : {}),
          }
        }
        // Reuse the report's verdict — this row and the run header MUST agree.
        // They used to disagree (`scores.every(s => s.passed)` here counted
        // not-applicable scores as failures), so the header read 100% while
        // every row below it read FAIL.
        const verdict = repetitionVerdict(rep0)
        void deps.saveCaseResult({
          runId,
          caseId: result.caseId,
          scores,
          verdict,
          passAt1: verdict === "pass",
        })
      },
    })
    const enriched: EvalReport = {
      ...report,
      datasetVersionId: version.id,
      config: {
        targetKind: spec.kind,
        scorerIds: config.scorerIds,
        k,
        ...(config.subset ? { subset: config.subset } : {}),
      },
    }
    await deps.saveRun(enriched)
    reports.push(enriched)
  }
  return reports
}
