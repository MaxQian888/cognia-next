/**
 * Judge-calibration run persistence (Dexie v82) — one row per executed
 * calibration of a judge against a human-labeled set (eval spec §10).
 *
 * The row IS the full report (mirrors `eval-runs.ts` where `EvalRunRow` holds
 * the whole `EvalReport`): it inlines the agreement `metrics` snapshot and the
 * per-item `verdicts`, so the disagreement list and "κ over time" history need
 * no second table. `rubric` + `judgeModel` + per-verdict `goldLabel` are
 * snapshotted, making old runs valid regression baselines even after the set's
 * items are later edited.
 */

import type { AgreementMetrics } from "@/lib/ai/eval/calibration/metrics"
import type { CalibrationLabel } from "./calibration-items"
import { getDb } from "./schema"

/** The judge's verdict on one calibration item, vs. the human gold label. */
export interface CalibrationVerdict {
  itemId: string
  /** Human gold label, snapshotted at run time. */
  goldLabel: CalibrationLabel
  judgeValue: 0 | 1
  judgePassed: boolean
  /**
   * True when the judge fail-opened (LLM/parse error). Excluded from metrics
   * (not-applicable, not a "fail") but kept for transparency.
   */
  errored: boolean
  reasoning?: string
  error?: string
}

export interface CalibrationRunRow {
  runId: string
  setId: string
  /** Criterion calibrated (snapshot from the set). */
  criterion: string
  /** Rubric calibrated (snapshot — old runs stay comparable). */
  rubric: string
  /** Cross-model judge model used (provenance). */
  judgeModel: string
  /** Items attempted. */
  itemCount: number
  /** Items with a usable (non-errored) verdict — the metric denominator. */
  scoredCount: number
  /** Items where the judge fail-opened. */
  erroredCount: number
  /** Agreement snapshot from `computeAgreement`. */
  metrics: AgreementMetrics
  /** Per-item verdicts (drives the disagreement list). */
  verdicts: CalibrationVerdict[]
  createdAt: number
}

export async function saveCalibrationRun(row: CalibrationRunRow): Promise<void> {
  await getDb().calibrationRuns.put(row)
}

export async function getCalibrationRun(runId: string): Promise<CalibrationRunRow | undefined> {
  if (!runId) return undefined
  return getDb().calibrationRuns.get(runId)
}

/** Runs for a set, newest first. */
export async function listRunsBySet(setId: string): Promise<CalibrationRunRow[]> {
  if (!setId) return []
  const rows = await getDb().calibrationRuns.where("setId").equals(setId).toArray()
  rows.sort((a, b) => b.createdAt - a.createdAt)
  return rows
}

/** Latest calibration evidence across sets, for project judge preflight. */
export async function listRecentCalibrationRuns(limit = 50): Promise<CalibrationRunRow[]> {
  if (limit <= 0) return []
  const rows = await getDb().calibrationRuns.orderBy("createdAt").reverse().limit(limit).toArray()
  return rows
}

export async function deleteCalibrationRun(runId: string): Promise<void> {
  if (!runId) return
  await getDb().calibrationRuns.delete(runId)
}

export async function deleteRunsBySet(setId: string): Promise<void> {
  if (!setId) return
  await getDb().calibrationRuns.where("setId").equals(setId).delete()
}
