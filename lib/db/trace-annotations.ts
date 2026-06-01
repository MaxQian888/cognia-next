/**
 * Trace annotation persistence (Dexie v64) — the error-analysis substrate.
 *
 * One row per annotated `agentTraces` trace: the open-coded "first failure"
 * note and an optional axial-coding `failureMode` cluster label. This is the
 * "look at your data" flywheel — read real traces, label the first failure,
 * roll up into a taxonomy (`failureModeCounts`), then "save as eval case"
 * (tracked via `savedAsCaseId`).
 *
 * `traceId` is unique, so {@link upsertAnnotation} edits in place.
 */

import { getDb } from "./schema"

export interface TraceAnnotationRow {
  id: string
  /** The annotated trace (unique). */
  traceId: string
  /** Session the trace belongs to. */
  sessionId: string
  /** Open-coded note: what went wrong first in this trace. */
  firstFailureNote: string
  /** Axial-coding cluster label, assigned when building the taxonomy. */
  failureMode?: string
  /** The eval case id this trace was promoted into, if any. */
  savedAsCaseId?: string
  createdAt: number
  updatedAt: number
}

function annotationId(): string {
  return "evan_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8)
}

export interface UpsertAnnotationInput {
  traceId: string
  sessionId: string
  firstFailureNote: string
  failureMode?: string
  createdAt?: number
}

export async function upsertAnnotation(input: UpsertAnnotationInput): Promise<TraceAnnotationRow> {
  const existing = await getAnnotationByTrace(input.traceId)
  const now = input.createdAt ?? Date.now()
  const row: TraceAnnotationRow = {
    id: existing?.id ?? annotationId(),
    traceId: input.traceId,
    sessionId: input.sessionId,
    firstFailureNote: input.firstFailureNote,
    ...(input.failureMode !== undefined ? { failureMode: input.failureMode } : {}),
    ...(existing?.savedAsCaseId ? { savedAsCaseId: existing.savedAsCaseId } : {}),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  }
  await getDb().traceAnnotations.put(row)
  return row
}

export async function getAnnotationByTrace(
  traceId: string
): Promise<TraceAnnotationRow | undefined> {
  if (!traceId) return undefined
  return getDb().traceAnnotations.where("traceId").equals(traceId).first()
}

export async function listAnnotations(): Promise<TraceAnnotationRow[]> {
  const rows = await getDb().traceAnnotations.toArray()
  rows.sort((a, b) => b.createdAt - a.createdAt)
  return rows
}

/** Count annotations grouped by `failureMode`; unlabeled rows are ignored. */
export async function failureModeCounts(): Promise<Record<string, number>> {
  const rows = await getDb().traceAnnotations.toArray()
  const counts: Record<string, number> = {}
  for (const r of rows) {
    if (!r.failureMode) continue
    counts[r.failureMode] = (counts[r.failureMode] ?? 0) + 1
  }
  return counts
}

export async function markSavedAsCase(traceId: string, caseId: string): Promise<void> {
  const existing = await getAnnotationByTrace(traceId)
  if (!existing) return
  await getDb().traceAnnotations.put({ ...existing, savedAsCaseId: caseId, updatedAt: Date.now() })
}

export async function deleteAnnotation(id: string): Promise<void> {
  if (!id) return
  await getDb().traceAnnotations.delete(id)
}
