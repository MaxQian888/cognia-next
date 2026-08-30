/**
 * Eval service facade — the ONE entry the UI, the `eval.run`/`eval.gate`
 * workflow nodes, and the `cognia-eval` plugin tools call. Composes the
 * existing engine (`runConfiguredEval` over `buildConfiguredRunDeps`) and the
 * gate (`evaluateGate` against the dataset's stored thresholds), and fans
 * per-case saves out into an `onProgress` callback. Engine untouched.
 */

import type { AppSettings } from "@cognia/agent-config-types"
import type { EvalReport } from "@/types/eval/eval"
import type { EvalRunConfig } from "@/types/eval/run-config"
import type { GateResult } from "@/types/eval/gate"
import { evaluateGate } from "@cognia/eval-core"
import { filterCases, runConfiguredEval, type RunConfiguredDeps } from "./run-config"
import { buildConfiguredRunDeps } from "./browser-deps"

export interface EvalProgress {
  done: number
  total: number
  /** Cases that passed every scored scorer on repetition 1 so far. */
  passing: number
  /**
   * Cases no selected scorer could grade so far. Reported separately because a
   * live "0 passing" that is really "nothing is being graded" is the single
   * most misleading thing this progress bar can say.
   */
  ungraded: number
}

export interface RunEvalServiceInput {
  datasetId: string
  config: EvalRunConfig
  appSettings: AppSettings | null
  /** Override the cross-model judge. */
  judgeModel?: string
  /** Skip the LLM judge tier — deterministic scorers only. */
  forceDeterministic?: boolean
  signal?: AbortSignal
  onProgress?: (p: EvalProgress) => void
  /** Test / caller seam — defaults to the browser/Dexie wiring. */
  deps?: RunConfiguredDeps
}

export interface RunEvalServiceResult {
  reports: EvalReport[]
  /** Per-run gate verdicts; only set when the dataset has thresholds. */
  gates?: Record<string, GateResult>
  /** AND across all reports; undefined when no gate is configured. */
  gatePassed?: boolean
  /** True when no judge client resolved — deterministic scorers only. */
  deterministicOnly: boolean
}

export async function runEvalService(input: RunEvalServiceInput): Promise<RunEvalServiceResult> {
  let deterministicOnly = false
  let deps = input.deps
  if (!deps) {
    const wired = buildConfiguredRunDeps({
      appSettings: input.appSettings,
      ...(input.judgeModel ? { judgeModel: input.judgeModel } : {}),
      ...(input.forceDeterministic ? { forceDeterministic: true } : {}),
    })
    deps = wired.deps
    deterministicOnly = wired.deterministicOnly
  }

  const dataset = await deps.loadDataset(input.datasetId)
  if (!dataset) throw new Error(`runEvalService: dataset "${input.datasetId}" not found`)

  const caseCount = filterCases(await deps.loadCases(input.datasetId), input.config.subset).length
  const total = caseCount * Math.max(1, input.config.targets.length)
  let done = 0
  let passing = 0
  let ungraded = 0
  const baseSave = deps.saveCaseResult.bind(deps)
  const progressDeps: RunConfiguredDeps = {
    ...deps,
    saveCaseResult: async (row) => {
      await baseSave(row)
      done += 1
      if (row.verdict === "ungraded") ungraded += 1
      else if (row.verdict === "pass") passing += 1
      input.onProgress?.({ done, total, passing, ungraded })
    },
  }

  const reports = await runConfiguredEval(input.datasetId, input.config, progressDeps, input.signal)

  if (!dataset.gate) return { reports, deterministicOnly }
  const gates: Record<string, GateResult> = {}
  for (const r of reports) gates[r.runId] = evaluateGate(r, dataset.gate)
  return {
    reports,
    gates,
    gatePassed: Object.values(gates).every((g) => g.passed),
    deterministicOnly,
  }
}

// ── Read-side queries (browser/Dexie wired — thin, mirrors browser-deps) ─────

export interface EvalDatasetSummary {
  id: string
  name: string
  capability: string
  version: number
  caseCount: number
  latestRun?: { runId: string; passAt1: number; createdAt: number; targetLabel: string }
}

export async function listDatasetSummaries(): Promise<EvalDatasetSummary[]> {
  const { listDatasets, listCases } = await import("@/lib/db/eval-datasets")
  const { listRunsByDataset } = await import("@/lib/db/eval-runs")
  const datasets = await listDatasets()
  return Promise.all(
    datasets.map(async (d) => {
      const [cases, runs] = await Promise.all([listCases(d.id), listRunsByDataset(d.id)])
      const latest = runs[0]
      return {
        id: d.id,
        name: d.name,
        capability: d.capability,
        version: d.version,
        caseCount: cases.length,
        ...(latest
          ? {
              latestRun: {
                runId: latest.runId,
                passAt1: latest.passAt1,
                createdAt: latest.createdAt,
                targetLabel: latest.targetLabel,
              },
            }
          : {}),
      }
    })
  )
}

export interface EvalRunDetail {
  report: import("@/lib/db/eval-runs").EvalRunRow
  cases: import("@/lib/db/eval-run-cases").EvalRunCaseRow[]
}

export async function getRunDetail(runId: string): Promise<EvalRunDetail | undefined> {
  const { getRun } = await import("@/lib/db/eval-runs")
  const { listCaseResults } = await import("@/lib/db/eval-run-cases")
  const report = await getRun(runId)
  if (!report) return undefined
  return { report, cases: await listCaseResults(runId) }
}
