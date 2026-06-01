/**
 * Eval dataset + case persistence (Dexie v64).
 *
 * `evalDatasets` holds versioned, capability-scoped collections; `evalCases`
 * holds the per-dataset test items. Mutating a case (add / update / delete)
 * bumps the parent dataset's `version` so a run can pin exactly which dataset
 * snapshot produced a score (the design doc's "version your eval sets" rule).
 *
 * All Dexie access for these two tables lives here so the rest of the app never
 * opens them directly (mirrors `lib/db/agent-traces.ts`).
 */

import type { EvalCase, EvalDataset } from "@/types/eval/eval"
import { getDb } from "./schema"

function datasetId(): string {
  return "evds_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8)
}

function caseId(): string {
  return "evc_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8)
}

export interface CreateDatasetInput {
  name: string
  description?: string
  capability: string
  id?: string
  createdAt?: number
}

export async function createDataset(input: CreateDatasetInput): Promise<EvalDataset> {
  const now = input.createdAt ?? Date.now()
  const row: EvalDataset = {
    id: input.id ?? datasetId(),
    name: input.name,
    ...(input.description ? { description: input.description } : {}),
    capability: input.capability,
    version: 1,
    createdAt: now,
    updatedAt: now,
  }
  await getDb().evalDatasets.put(row)
  return row
}

export async function getDataset(id: string): Promise<EvalDataset | undefined> {
  if (!id) return undefined
  return getDb().evalDatasets.get(id)
}

export async function listDatasets(): Promise<EvalDataset[]> {
  const rows = await getDb().evalDatasets.toArray()
  rows.sort((a, b) => b.updatedAt - a.updatedAt)
  return rows
}

export async function listDatasetsByCapability(capability: string): Promise<EvalDataset[]> {
  const rows = await getDb().evalDatasets.where("capability").equals(capability).toArray()
  rows.sort((a, b) => b.updatedAt - a.updatedAt)
  return rows
}

export async function updateDataset(
  id: string,
  patch: Partial<Pick<EvalDataset, "name" | "description">>
): Promise<EvalDataset | undefined> {
  const existing = await getDataset(id)
  if (!existing) return undefined
  const next: EvalDataset = { ...existing, ...patch, updatedAt: Date.now() }
  await getDb().evalDatasets.put(next)
  return next
}

export async function deleteDataset(id: string): Promise<void> {
  if (!id) return
  await getDb().evalCases.where("datasetId").equals(id).delete()
  await getDb().evalDatasets.delete(id)
}

/** Increment the parent dataset's version + updatedAt (case-mutation marker). */
async function bumpDatasetVersion(datasetIdValue: string): Promise<void> {
  const ds = await getDataset(datasetIdValue)
  if (!ds) return
  await getDb().evalDatasets.put({ ...ds, version: ds.version + 1, updatedAt: Date.now() })
}

export type AddCaseInput = Omit<
  EvalCase,
  "id" | "datasetId" | "capability" | "createdAt" | "updatedAt"
> & {
  id?: string
  /** Defaults to the dataset's capability when omitted. */
  capability?: string
  createdAt?: number
}

export async function addCase(datasetIdValue: string, input: AddCaseInput): Promise<EvalCase> {
  const ds = await getDataset(datasetIdValue)
  if (!ds) throw new Error(`addCase: dataset "${datasetIdValue}" not found`)
  const now = input.createdAt ?? Date.now()
  const row: EvalCase = {
    id: input.id ?? caseId(),
    datasetId: datasetIdValue,
    input: input.input,
    capability: input.capability ?? ds.capability,
    source: input.source,
    createdAt: now,
    updatedAt: now,
    ...(input.history ? { history: input.history } : {}),
    ...(input.reference ? { reference: input.reference } : {}),
    ...(input.failureMode ? { failureMode: input.failureMode } : {}),
    ...(input.sourceTraceId ? { sourceTraceId: input.sourceTraceId } : {}),
    ...(input.notes ? { notes: input.notes } : {}),
  }
  await getDb().evalCases.put(row)
  await bumpDatasetVersion(datasetIdValue)
  return row
}

export async function getCase(id: string): Promise<EvalCase | undefined> {
  if (!id) return undefined
  return getDb().evalCases.get(id)
}

export async function listCases(datasetIdValue: string): Promise<EvalCase[]> {
  if (!datasetIdValue) return []
  const rows = await getDb().evalCases.where("datasetId").equals(datasetIdValue).toArray()
  rows.sort((a, b) => a.createdAt - b.createdAt)
  return rows
}

export async function updateCase(
  id: string,
  patch: Partial<Omit<EvalCase, "id" | "datasetId" | "createdAt">>
): Promise<EvalCase | undefined> {
  const existing = await getCase(id)
  if (!existing) return undefined
  const next: EvalCase = { ...existing, ...patch, updatedAt: Date.now() }
  await getDb().evalCases.put(next)
  await bumpDatasetVersion(existing.datasetId)
  return next
}

export async function deleteCase(id: string): Promise<void> {
  const existing = await getCase(id)
  if (!existing) return
  await getDb().evalCases.delete(id)
  await bumpDatasetVersion(existing.datasetId)
}
