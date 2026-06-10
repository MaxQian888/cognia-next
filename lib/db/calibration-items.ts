/**
 * Judge-calibration item persistence (Dexie v82) — the human-gold substrate for
 * eval spec §10 ("maintain a human-labeled calibration set").
 *
 * One row per labeled (input, answer) pair tied to a specific judge target
 * (`criterion` + `rubric`). The human `goldLabel` is the ground truth the
 * calibration run scores the LLM-judge against. Items are grouped into a
 * calibration *set* by `setId`; a set is homogeneous (one judge) in v1, so the
 * criterion/rubric are denormalized onto each item and the runner snapshots the
 * set's first item.
 *
 * Mirrors `lib/db/trace-annotations.ts`: `calit_`-prefixed ids, upsert-in-place
 * by id, createdAt-desc listing, in-memory group-by for set summaries.
 */

import type { EvalHistoryTurn } from "@/types/eval/eval"
import { getDb } from "./schema"

export type CalibrationLabel = "pass" | "fail"
export type CalibrationItemSource = "real-trace" | "eval-case" | "handwritten"

export interface CalibrationItemRow {
  id: string
  /** Groups items into a calibration set. */
  setId: string
  /** The single criterion of the judge being calibrated. */
  criterion: string
  /** The judge rubric (pass/fail definition) being calibrated. */
  rubric: string
  /** The user request the judge scores. */
  input: string
  /** The assistant answer the judge scores. */
  output: string
  /** Optional gold reference answer the judge may use. */
  reference?: string
  /** Optional prior conversation turns. */
  history?: EvalHistoryTurn[]
  /** HUMAN ground truth: does the answer satisfy the criterion? */
  goldLabel: CalibrationLabel
  source: CalibrationItemSource
  /** Provenance when `source === "real-trace"`. */
  sourceTraceId?: string
  /** Provenance when `source === "eval-case"`. */
  sourceCaseId?: string
  notes?: string
  createdAt: number
  updatedAt: number
}

/** Compact summary of one calibration set for the picker. */
export interface CalibrationSetSummary {
  setId: string
  criterion: string
  rubric: string
  itemCount: number
}

function calibrationItemId(): string {
  return "calit_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8)
}

export interface UpsertCalibrationItemInput {
  /** Provide to edit an existing row in place; omit to create. */
  id?: string
  setId: string
  criterion: string
  rubric: string
  input: string
  output: string
  reference?: string
  history?: EvalHistoryTurn[]
  goldLabel: CalibrationLabel
  source: CalibrationItemSource
  sourceTraceId?: string
  sourceCaseId?: string
  notes?: string
  createdAt?: number
}

export async function upsertCalibrationItem(
  input: UpsertCalibrationItemInput
): Promise<CalibrationItemRow> {
  const existing = input.id ? await getCalibrationItem(input.id) : undefined
  const now = input.createdAt ?? Date.now()
  const row: CalibrationItemRow = {
    id: existing?.id ?? input.id ?? calibrationItemId(),
    setId: input.setId,
    criterion: input.criterion,
    rubric: input.rubric,
    input: input.input,
    output: input.output,
    ...(input.reference !== undefined ? { reference: input.reference } : {}),
    ...(input.history !== undefined ? { history: input.history } : {}),
    goldLabel: input.goldLabel,
    source: input.source,
    ...(input.sourceTraceId !== undefined ? { sourceTraceId: input.sourceTraceId } : {}),
    ...(input.sourceCaseId !== undefined ? { sourceCaseId: input.sourceCaseId } : {}),
    ...(input.notes !== undefined ? { notes: input.notes } : {}),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  }
  await getDb().calibrationItems.put(row)
  return row
}

export async function getCalibrationItem(id: string): Promise<CalibrationItemRow | undefined> {
  if (!id) return undefined
  return getDb().calibrationItems.get(id)
}

/** Items in a set, newest first. */
export async function listItemsBySet(setId: string): Promise<CalibrationItemRow[]> {
  if (!setId) return []
  const rows = await getDb().calibrationItems.where("setId").equals(setId).toArray()
  rows.sort((a, b) => b.createdAt - a.createdAt)
  return rows
}

/** Distinct calibration sets with item counts (in-memory group-by). */
export async function listCalibrationSets(): Promise<CalibrationSetSummary[]> {
  const rows = await getDb().calibrationItems.toArray()
  const map = new Map<string, CalibrationSetSummary>()
  // Newest item per set wins for the denormalized criterion/rubric.
  const ordered = [...rows].sort((a, b) => a.createdAt - b.createdAt)
  for (const r of ordered) {
    const existing = map.get(r.setId)
    map.set(r.setId, {
      setId: r.setId,
      criterion: r.criterion,
      rubric: r.rubric,
      itemCount: (existing?.itemCount ?? 0) + 1,
    })
  }
  return [...map.values()].sort((a, b) => a.setId.localeCompare(b.setId))
}

export async function setGoldLabel(id: string, label: CalibrationLabel): Promise<void> {
  const existing = await getCalibrationItem(id)
  if (!existing) return
  await getDb().calibrationItems.put({ ...existing, goldLabel: label, updatedAt: Date.now() })
}

export async function deleteCalibrationItem(id: string): Promise<void> {
  if (!id) return
  await getDb().calibrationItems.delete(id)
}

export async function deleteItemsBySet(setId: string): Promise<void> {
  if (!setId) return
  await getDb().calibrationItems.where("setId").equals(setId).delete()
}
