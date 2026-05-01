/**
 * CRUD layer for the `twinChunks` Dexie table.
 *
 * Each row is a single sliced chunk with both the original text and the
 * PII-redacted version, plus a pointer (`vectorBackend` + `vectorCollection`
 * + `vectorDocId`) into the remote vector store. The runtime
 * (`lib/twin/runtime/apply-twin-context.ts`, Phase 6) resolves vector search
 * hits to full chunks via `getTwinChunkByVectorDocId`.
 */

import type { TwinChunk } from "@/types/twin"
import { getDb } from "./schema"

function newId(): string {
  return "twc_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8)
}

export type TwinChunkDraft = Omit<TwinChunk, "id" | "createdAt"> &
  Partial<Pick<TwinChunk, "id" | "createdAt">>

export async function createTwinChunk(draft: TwinChunkDraft): Promise<TwinChunk> {
  const row: TwinChunk = {
    id: draft.id ?? newId(),
    twinId: draft.twinId,
    sourceId: draft.sourceId,
    content: draft.content,
    contentRedacted: draft.contentRedacted,
    charStart: draft.charStart,
    charEnd: draft.charEnd,
    vectorBackend: draft.vectorBackend,
    vectorCollection: draft.vectorCollection,
    vectorDocId: draft.vectorDocId,
    strategy: draft.strategy,
    tokenCount: draft.tokenCount,
    metadata: draft.metadata,
    entityTags: draft.entityTags,
    createdAt: draft.createdAt ?? Date.now(),
  }
  await getDb().twinChunks.add(row)
  return row
}

export async function bulkCreateTwinChunks(drafts: TwinChunkDraft[]): Promise<TwinChunk[]> {
  if (drafts.length === 0) return []
  const now = Date.now()
  const rows: TwinChunk[] = drafts.map((draft) => ({
    id: draft.id ?? newId(),
    twinId: draft.twinId,
    sourceId: draft.sourceId,
    content: draft.content,
    contentRedacted: draft.contentRedacted,
    charStart: draft.charStart,
    charEnd: draft.charEnd,
    vectorBackend: draft.vectorBackend,
    vectorCollection: draft.vectorCollection,
    vectorDocId: draft.vectorDocId,
    strategy: draft.strategy,
    tokenCount: draft.tokenCount,
    metadata: draft.metadata,
    entityTags: draft.entityTags,
    createdAt: draft.createdAt ?? now,
  }))
  await getDb().twinChunks.bulkAdd(rows)
  return rows
}

export async function getTwinChunk(id: string): Promise<TwinChunk | undefined> {
  return getDb().twinChunks.get(id)
}

export async function getTwinChunksByIds(ids: string[]): Promise<TwinChunk[]> {
  if (ids.length === 0) return []
  const rows = await getDb().twinChunks.bulkGet(ids)
  return rows.filter((r): r is TwinChunk => r !== undefined)
}

export async function getTwinChunkByVectorDocId(
  vectorDocId: string
): Promise<TwinChunk | undefined> {
  return getDb().twinChunks.where("vectorDocId").equals(vectorDocId).first()
}

export async function getTwinChunksByVectorDocIds(vectorDocIds: string[]): Promise<TwinChunk[]> {
  if (vectorDocIds.length === 0) return []
  return getDb().twinChunks.where("vectorDocId").anyOf(vectorDocIds).toArray()
}

export async function listTwinChunksBySource(sourceId: string): Promise<TwinChunk[]> {
  return getDb().twinChunks.where("sourceId").equals(sourceId).toArray()
}

export async function listTwinChunksByTwin(
  twinId: string,
  options?: { limit?: number; offset?: number }
): Promise<TwinChunk[]> {
  let coll = getDb().twinChunks.where("twinId").equals(twinId)
  if (options?.offset) coll = coll.offset(options.offset)
  if (options?.limit) coll = coll.limit(options.limit)
  return coll.toArray()
}

export async function countTwinChunksByTwin(twinId: string): Promise<number> {
  return getDb().twinChunks.where("twinId").equals(twinId).count()
}

export async function updateTwinChunk(
  id: string,
  patch: Partial<Omit<TwinChunk, "id" | "twinId" | "sourceId">>
): Promise<TwinChunk | undefined> {
  await getDb().twinChunks.update(id, patch as Partial<TwinChunk>)
  return getDb().twinChunks.get(id)
}

export async function deleteTwinChunk(id: string): Promise<void> {
  await getDb().twinChunks.delete(id)
}

export async function deleteTwinChunksBySource(sourceId: string): Promise<number> {
  return getDb().twinChunks.where("sourceId").equals(sourceId).delete()
}
