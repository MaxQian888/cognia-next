/**
 * Compact per-case eval verdicts (Dexie v69).
 *
 * One row per (run, case): the scorer verdicts + a pass@1 flag, NOT the full
 * sample (which can be large and is only needed live). This is what the A-vs-B
 * comparison grid (`lib/ai/eval/compare.ts`) reads. All Dexie access for the
 * table lives here so the rest of the app never opens it directly (mirrors
 * `lib/db/eval-runs.ts`).
 */

import { getDb } from "./schema"
import type { EvalRunCaseRow } from "@cognia/plugin-contract/lib/db/eval-run-cases"
export type { EvalRunCaseRow } from "@cognia/plugin-contract/lib/db/eval-run-cases"

export type SaveCaseResultInput = Omit<EvalRunCaseRow, "id">

export async function saveCaseResult(input: SaveCaseResultInput): Promise<void> {
  if (!input.runId || !input.caseId) return
  await getDb().evalRunCaseResults.put({ ...input, id: `${input.runId}::${input.caseId}` })
}

export async function listCaseResults(runId: string): Promise<EvalRunCaseRow[]> {
  if (!runId) return []
  return getDb().evalRunCaseResults.where("runId").equals(runId).toArray()
}

export async function deleteCaseResultsForRun(runId: string): Promise<void> {
  if (!runId) return
  await getDb().evalRunCaseResults.where("runId").equals(runId).delete()
}
