/**
 * Eval run persistence (Dexie v64).
 *
 * One row per executed run, where the row IS the aggregated {@link EvalReport}
 * (keyed by `runId`). This is the dashboard's trend source — per-dataset score
 * history over time. Raw per-case results are NOT persisted here (they can be
 * large and are only needed live); the report's per-scorer aggregates + pass^k
 * are what trends and gating consume.
 */

import type { EvalReport } from "@/types/eval/eval"
import { getDb } from "./schema"
import { deleteCaseResultsForRun } from "./eval-run-cases"

/** The persisted run row is exactly the aggregated report. */
export type EvalRunRow = EvalReport

export async function saveRun(report: EvalReport): Promise<void> {
  if (!report.runId) return
  await getDb().evalRuns.put(report)
}

export async function getRun(runId: string): Promise<EvalRunRow | undefined> {
  if (!runId) return undefined
  return getDb().evalRuns.get(runId)
}

export async function listRunsByDataset(datasetId: string): Promise<EvalRunRow[]> {
  if (!datasetId) return []
  const rows = await getDb().evalRuns.where("datasetId").equals(datasetId).toArray()
  rows.sort((a, b) => b.createdAt - a.createdAt)
  return rows
}

export async function listRecentRuns(limit = 50): Promise<EvalRunRow[]> {
  const safe = Math.max(0, Math.floor(limit))
  if (safe === 0) return []
  const rows = await getDb().evalRuns.toArray()
  rows.sort((a, b) => b.createdAt - a.createdAt)
  return rows.slice(0, safe)
}

/** Delete a run and cascade its compact per-case verdicts (`evalRunCaseResults`),
 * which are keyed by `runId` and have no other owner. Atomic — a half-delete
 * would leave orphan case rows the A-vs-B grid can never reach. */
export async function deleteRun(runId: string): Promise<void> {
  if (!runId) return
  const db = getDb()
  await db.transaction("rw", db.evalRuns, db.evalRunCaseResults, async () => {
    await deleteCaseResultsForRun(runId)
    await db.evalRuns.delete(runId)
  })
}

/** Delete every run for a dataset and cascade all their case verdicts. Resolves
 * the run ids first so a single `anyOf` delete clears the child rows in one pass. */
export async function deleteRunsForDataset(datasetId: string): Promise<void> {
  if (!datasetId) return
  const db = getDb()
  await db.transaction("rw", db.evalRuns, db.evalRunCaseResults, async () => {
    const runIds = (await db.evalRuns
      .where("datasetId")
      .equals(datasetId)
      .primaryKeys()) as string[]
    if (runIds.length > 0) {
      await db.evalRunCaseResults.where("runId").anyOf(runIds).delete()
    }
    await db.evalRuns.where("datasetId").equals(datasetId).delete()
  })
}
