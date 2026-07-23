/**
 * Eval dataset version snapshots (Dexie v69).
 *
 * Approach A: freeze the current case set into an immutable row keyed by an
 * order-independent content hash so runs pin to an exact snapshot and
 * comparison stays apples-to-apples after later case edits. All Dexie access
 * for the table lives here (mirrors `lib/db/eval-datasets.ts`).
 *
 * Snapshots store case IDS, not copies. Storing copies meant every
 * edit-then-run cycle on a thousand-case benchmark wrote about half a megabyte
 * of duplicated case text into IndexedDB. Rows written before that change keep
 * their `cases` array and are still readable.
 */

import type { EvalDatasetVersion } from "@/types/eval/version"
import type { EvalCase } from "@/types/eval/eval"
import { getDb } from "./schema"
import { getDataset, listCases } from "./eval-datasets"

function versionId(): string {
  return "evdv_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8)
}

/**
 * Order-independent FNV-1a hash over normalized case JSON. Timestamps are
 * zeroed so a snapshot's identity depends on case content, not when rows were
 * written.
 */
export function hashCases(cases: EvalCase[]): string {
  const norm = cases
    .map((c) => JSON.stringify({ ...c, createdAt: 0, updatedAt: 0 }))
    .sort()
    .join("")
  let h = 0x811c9dc5
  for (let i = 0; i < norm.length; i++) {
    h ^= norm.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16)
}

/**
 * Freeze the dataset's current cases into a version snapshot. Idempotent within
 * a dataset version: if a snapshot with the same content hash already exists
 * for the current `version`, it is returned instead of creating a duplicate.
 */
export async function snapshotVersion(datasetId: string): Promise<EvalDatasetVersion> {
  const ds = await getDataset(datasetId)
  if (!ds) throw new Error(`snapshotVersion: dataset "${datasetId}" not found`)
  const cases = await listCases(datasetId)
  const casesHash = hashCases(cases)
  const existing = await getDb()
    .evalDatasetVersions.where("[datasetId+version]")
    .equals([datasetId, ds.version])
    .toArray()
  const dup = existing.find((v) => v.casesHash === casesHash)
  if (dup) return dup
  const row: EvalDatasetVersion = {
    id: versionId(),
    datasetId,
    version: ds.version,
    // Ids, not full copies — see the type's docblock. The hash still pins the
    // CONTENT, so an edit that leaves the id set unchanged still yields a new
    // snapshot.
    caseIds: cases.map((c) => c.id),
    casesHash,
    createdAt: Date.now(),
  }
  await getDb().evalDatasetVersions.put(row)
  return row
}

export async function getVersion(id: string): Promise<EvalDatasetVersion | undefined> {
  if (!id) return undefined
  return getDb().evalDatasetVersions.get(id)
}

export async function listVersions(datasetId: string): Promise<EvalDatasetVersion[]> {
  if (!datasetId) return []
  const rows = await getDb().evalDatasetVersions.where("datasetId").equals(datasetId).toArray()
  rows.sort((a, b) => b.createdAt - a.createdAt)
  return rows
}

/** Set or clear a human tag on a version (e.g. "prod"). */
export async function tagVersion(id: string, tag: string): Promise<void> {
  const v = await getVersion(id)
  if (!v) return
  const next: EvalDatasetVersion = { ...v, ...(tag ? { tag } : {}) }
  if (!tag) delete next.tag
  await getDb().evalDatasetVersions.put(next)
}

export async function deleteVersionsForDataset(datasetId: string): Promise<void> {
  if (!datasetId) return
  await getDb().evalDatasetVersions.where("datasetId").equals(datasetId).delete()
}
