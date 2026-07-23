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
import { deleteRunsForDataset } from "./eval-runs"

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
  /** Gate template stamped onto the new dataset (from eval settings defaults). */
  gate?: import("@/types/eval/gate").GateThresholds
}

export async function createDataset(input: CreateDatasetInput): Promise<EvalDataset> {
  const now = input.createdAt ?? Date.now()
  const row: EvalDataset = {
    id: input.id ?? datasetId(),
    name: input.name,
    ...(input.description ? { description: input.description } : {}),
    capability: input.capability,
    version: 1,
    ...(input.gate && Object.keys(input.gate).length > 0 ? { gate: input.gate } : {}),
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
  patch: Partial<Pick<EvalDataset, "name" | "description" | "gate" | "defaultGrading">>
): Promise<EvalDataset | undefined> {
  const existing = await getDataset(id)
  if (!existing) return undefined
  const next: EvalDataset = { ...existing, ...patch, updatedAt: Date.now() }
  await getDb().evalDatasets.put(next)
  return next
}

/**
 * Delete a dataset and cascade every dependent table so no orphan rows survive:
 * its cases, its runs (which in turn cascade their per-case verdicts via
 * {@link deleteRunsForDataset}), and its immutable version snapshots. All in one
 * transaction — a dataset is the root of the eval object graph, so a partial
 * delete would strand runs/versions the UI can never reach again.
 *
 * `deleteVersionsForDataset` is deliberately NOT imported here: `eval-dataset-versions`
 * already imports from this module, so reusing it would create an import cycle.
 * The one-line `evalDatasetVersions` delete below is the same primitive inlined.
 */
export async function deleteDataset(id: string): Promise<void> {
  if (!id) return
  const db = getDb()
  await db.transaction(
    "rw",
    [db.evalDatasets, db.evalCases, db.evalRuns, db.evalRunCaseResults, db.evalDatasetVersions],
    async () => {
      await db.evalCases.where("datasetId").equals(id).delete()
      await deleteRunsForDataset(id)
      await db.evalDatasetVersions.where("datasetId").equals(id).delete()
      await db.evalDatasets.delete(id)
    }
  )
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
    ...(input.tags ? { tags: input.tags } : {}),
    ...(input.split ? { split: input.split } : {}),
    ...(input.metadata ? { metadata: input.metadata } : {}),
    ...(input.inputVars ? { inputVars: input.inputVars } : {}),
  }
  await getDb().evalCases.put(row)
  await bumpDatasetVersion(datasetIdValue)
  return row
}

/**
 * Stable, dataset-scoped id for a case imported from a source that has its own
 * row id. Namespacing by dataset lets two datasets import the same benchmark
 * without colliding, and keeps the id in the PRIMARY KEY so an upsert is a
 * plain `put` — no new compound index, so no Dexie version bump.
 */
export function importedCaseId(datasetIdValue: string, sourceId: string): string {
  // FNV-1a over the dataset id: short, stable, and collision risk is irrelevant
  // because the source id already scopes within a dataset in practice.
  let h = 0x811c9dc5
  for (let i = 0; i < datasetIdValue.length; i++) {
    h ^= datasetIdValue.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return `evc_${(h >>> 0).toString(36)}_${sourceId}`
}

export interface BulkAddCasesOptions {
  /**
   * Treat `input.id` as a stable source id: existing rows with the same id are
   * OVERWRITTEN rather than duplicated, so re-importing a test set (e.g. after
   * fixing the field mapping) converges instead of doubling the dataset.
   */
  upsertBySourceId?: boolean
  /** Fired after each chunk lands, for import progress. */
  onProgress?: (written: number, total: number) => void
  /** Aborts between chunks; already-written chunks stay. */
  signal?: AbortSignal
}

export interface BulkAddCasesResult {
  added: number
  updated: number
}

/** Rows per transaction. Large enough to amortize, small enough to stay cancellable. */
const BULK_CHUNK = 200

/**
 * Insert many cases in chunked transactions, bumping the dataset version ONCE.
 *
 * The per-case {@link addCase} does four Dexie round-trips (read dataset, put
 * case, read dataset, put dataset) and a version bump each time, so importing a
 * real test set through it meant thousands of serial operations on the main
 * thread with no progress and no way out. This does one `bulkPut` per chunk and
 * a single version bump at the end.
 *
 * Not atomic across chunks by design: a 1300-case import held in one
 * transaction blocks every other Dexie reader for its duration, and a partial
 * import that reports how far it got is more useful than one that silently
 * rolls back. `onProgress` reports what actually landed.
 */
export async function bulkAddCases(
  datasetIdValue: string,
  inputs: AddCaseInput[],
  options: BulkAddCasesOptions = {}
): Promise<BulkAddCasesResult> {
  const ds = await getDataset(datasetIdValue)
  if (!ds) throw new Error(`bulkAddCases: dataset "${datasetIdValue}" not found`)
  if (inputs.length === 0) return { added: 0, updated: 0 }

  const db = getDb()
  const now = Date.now()
  let added = 0
  let updated = 0
  let written = 0

  for (let offset = 0; offset < inputs.length; offset += BULK_CHUNK) {
    if (options.signal?.aborted) break
    const slice = inputs.slice(offset, offset + BULK_CHUNK)
    const rows: EvalCase[] = slice.map((input) => ({
      id:
        input.id && options.upsertBySourceId
          ? importedCaseId(datasetIdValue, input.id)
          : (input.id ?? caseId()),
      datasetId: datasetIdValue,
      input: input.input,
      capability: input.capability ?? ds.capability,
      source: input.source,
      createdAt: input.createdAt ?? now,
      updatedAt: now,
      ...(input.history ? { history: input.history } : {}),
      ...(input.reference ? { reference: input.reference } : {}),
      ...(input.failureMode ? { failureMode: input.failureMode } : {}),
      ...(input.sourceTraceId ? { sourceTraceId: input.sourceTraceId } : {}),
      ...(input.notes ? { notes: input.notes } : {}),
      ...(input.tags ? { tags: input.tags } : {}),
      ...(input.split ? { split: input.split } : {}),
      ...(input.metadata ? { metadata: input.metadata } : {}),
      ...(input.inputVars ? { inputVars: input.inputVars } : {}),
    }))

    await db.transaction("rw", db.evalCases, async () => {
      const existing = await db.evalCases.bulkGet(rows.map((r) => r.id))
      existing.forEach((row, i) => {
        if (row) {
          updated += 1
          // Preserve the original creation time on re-import.
          rows[i].createdAt = row.createdAt
        } else {
          added += 1
        }
      })
      await db.evalCases.bulkPut(rows)
    })

    written += rows.length
    options.onProgress?.(written, inputs.length)
  }

  if (written > 0) await bumpDatasetVersion(datasetIdValue)
  return { added, updated }
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
