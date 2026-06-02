/**
 * Build an A-vs-B (vs-N) comparison from several runs' per-case verdicts.
 *
 * Rows are cases, columns are runs. The first run is the baseline; every other
 * cell carries a pass@1 delta vs the baseline and a `regression` flag (baseline
 * passed, this run failed). Pure — the UI feeds it persisted reports +
 * `evalRunCaseResults` rows.
 */

import type { EvalReport } from "@/types/eval/eval"
import type { EvalRunCaseRow } from "@/lib/db/eval-run-cases"
import type { ComparisonCell, ComparisonRow, RunComparison } from "@/types/eval/comparison"

export function buildComparison(
  reports: EvalReport[],
  caseResultsByRun: Record<string, EvalRunCaseRow[]>,
  inputs: Record<string, string> = {}
): RunComparison {
  const runIds = reports.map((r) => r.runId)
  if (runIds.length === 0) return { runIds: [], rows: [] }

  // Index each run's rows by caseId for O(1) cell lookup.
  const byRun = new Map<string, Map<string, EvalRunCaseRow>>()
  for (const runId of runIds) {
    const map = new Map<string, EvalRunCaseRow>()
    for (const row of caseResultsByRun[runId] ?? []) map.set(row.caseId, row)
    byRun.set(runId, map)
  }

  // Collect case ids in first-seen order across runs (baseline first).
  const caseIds: string[] = []
  const seen = new Set<string>()
  for (const runId of runIds) {
    for (const row of caseResultsByRun[runId] ?? []) {
      if (!seen.has(row.caseId)) {
        seen.add(row.caseId)
        caseIds.push(row.caseId)
      }
    }
  }

  const baselineId = runIds[0]
  const rows: ComparisonRow[] = caseIds.map((caseId) => {
    const baselineRow = byRun.get(baselineId)?.get(caseId)
    const baselinePass = baselineRow?.passAt1 ?? false
    const cells: ComparisonCell[] = runIds.map((runId, index) => {
      const row = byRun.get(runId)?.get(caseId)
      const passAt1 = row?.passAt1 ?? false
      const cell: ComparisonCell = {
        runId,
        scores: row?.scores ?? {},
        passAt1,
        regression: index > 0 && baselinePass && !passAt1,
      }
      if (index > 0) cell.delta = (passAt1 ? 1 : 0) - (baselinePass ? 1 : 0)
      return cell
    })
    return { caseId, input: inputs[caseId] ?? "", cells }
  })

  return { runIds, rows }
}
