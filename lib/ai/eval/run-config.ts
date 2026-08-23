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
import { repetitionVerdict, SCORING_VERSION } from "./report"
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
  /**
   * Characters of the agent's answer to persist per case. `0` stores none.
   * Defaults to {@link DEFAULT_STORED_OUTPUT_CHARS} when the caller says
   * nothing, so a run always leaves something to look at.
   */
  maxStoredOutputChars?: number
}

/** Fallback when a caller supplies no `maxStoredOutputChars`. */
export const DEFAULT_STORED_OUTPUT_CHARS = 4096

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
    const configSummary: EvalReport["config"] = {
      targetKind: spec.kind,
      ...(spec.kind === "workflow" ? { targetId: spec.workflowId } : {}),
      ...(spec.kind === "workflow" && spec.versionId ? { targetVersionId: spec.versionId } : {}),
      scorerIds: config.scorerIds,
      k,
      ...(config.subset ? { subset: config.subset } : {}),
    }
    // Claim the run row BEFORE the first case. Per-case rows are written as
    // they land, so a run that never wrote its parent left orphan
    // `evalRunCaseResults` rows: unreachable from every view, and never
    // reclaimed because deletion cascades from the run.
    await deps.saveRun({
      runId,
      datasetId,
      datasetVersion: dataset.version,
      targetLabel: spec.label,
      k,
      caseCount: cases.length,
      gradedCaseCount: 0,
      ungradedCaseCount: 0,
      scorers: {},
      passAt1: 0,
      passHatK: 0,
      totalCostUsd: 0,
      avgLatencyMs: 0,
      createdAt: deps.now(),
      scoringVersion: SCORING_VERSION,
      status: "running",
      datasetVersionId: version.id,
      config: configSummary,
    })
    const { report } = await runDatasetEval({
      dataset,
      cases,
      scorers,
      target,
      runId,
      now: deps.now(),
      k,
      ...(signal ? { signal } : {}),
      onCaseComplete: async (result) => {
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
        const cap = deps.maxStoredOutputChars ?? DEFAULT_STORED_OUTPUT_CHARS
        const raw = rep0.sample.output
        const truncated = cap > 0 && raw.length > cap
        await deps.saveCaseResult({
          runId,
          caseId: result.caseId,
          scores,
          verdict,
          passAt1: verdict === "pass",
          ...(cap > 0 && raw.length > 0 ? { output: truncated ? raw.slice(0, cap) : raw } : {}),
          ...(truncated ? { outputTruncated: true } : {}),
          ...(rep0.sample.error ? { sampleError: rep0.sample.error } : {}),
        })
      },
    })
    // A run stopped mid-way reports rates over the cases that DID finish, so
    // it must not look like a completed run — `aborted` withholds the gate.
    const aborted = signal?.aborted === true || report.caseCount < cases.length
    const enriched: EvalReport = {
      ...report,
      status: aborted ? "aborted" : "completed",
      datasetVersionId: version.id,
      config: configSummary,
    }
    await deps.saveRun(enriched)
    reports.push(enriched)
    if (aborted) break
  }
  return reports
}
