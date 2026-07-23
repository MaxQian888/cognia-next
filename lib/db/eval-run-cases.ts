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

export interface EvalRunCaseRow {
  /** Stable id — `${runId}::${caseId}`. */
  id: string
  runId: string
  caseId: string
  /**
   * scorerId → verdict on repetition 1. `status` distinguishes a real verdict
   * from a not-applicable / errored / measurement observation, so the grid can
   * render "—" instead of a red 0.00 for scores that never decided anything.
   * Absent on rows written before the scoring-status change.
   */
  scores: Record<
    string,
    {
      value: number
      passed: boolean
      status?: import("@/types/eval/eval").ScoreStatus
      reasoning?: string
    }
  >
  /**
   * `pass` / `fail` / `ungraded` for repetition 1, from
   * `lib/ai/eval/report.ts:repetitionVerdict` — the SAME function the run
   * header uses. Absent on legacy rows; fall back to {@link passAt1}.
   */
  verdict?: import("@/types/eval/eval").RepetitionVerdict
  /** Legacy mirror of `verdict === "pass"`. Kept so old rows stay readable. */
  passAt1: boolean
}

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
