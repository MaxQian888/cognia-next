/**
 * CRUD layer for the `projectChunks` Dexie table (project-scoped RAG).
 *
 * Each row is a single sliced chunk of a workspace `KnowledgeFile`, with both
 * the original text and the (optionally) PII-redacted version, plus a pointer
 * (`vectorBackend` + `vectorCollection` + `vectorDocId`) into the remote vector
 * store. The runtime (`lib/project-knowledge/runtime/retrieve.ts`) resolves
 * vector search hits back to full chunks via `getProjectChunksByVectorDocIds`.
 *
 * Mirrors `lib/db/twin-chunks.ts` but keyed by `projectId` (project-scoped)
 * instead of `twinId` (profile-global).
 */

import Dexie from "dexie"
import type { ProjectChunk } from "@/types/project-knowledge"
import { getDb } from "./schema"

function newId(): string {
  return "pkc_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8)
}

export type ProjectChunkDraft = Omit<ProjectChunk, "id" | "createdAt"> &
  Partial<Pick<ProjectChunk, "id" | "createdAt">>

function toRow(draft: ProjectChunkDraft, fallbackCreatedAt: number): ProjectChunk {
  return {
    id: draft.id ?? newId(),
    projectId: draft.projectId,
    fileId: draft.fileId,
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
    contentHash: draft.contentHash,
    createdAt: draft.createdAt ?? fallbackCreatedAt,
  }
}

export async function createProjectChunk(draft: ProjectChunkDraft): Promise<ProjectChunk> {
  const row = toRow(draft, Date.now())
  await getDb().projectChunks.add(row)
  return row
}

export async function bulkCreateProjectChunks(
  drafts: ProjectChunkDraft[]
): Promise<ProjectChunk[]> {
  if (drafts.length === 0) return []
  const now = Date.now()
  const rows = drafts.map((draft) => toRow(draft, now))
  await getDb().projectChunks.bulkAdd(rows)
  return rows
}

export async function getProjectChunk(id: string): Promise<ProjectChunk | undefined> {
  return getDb().projectChunks.get(id)
}

export async function getProjectChunksByVectorDocIds(
  vectorDocIds: string[]
): Promise<ProjectChunk[]> {
  if (vectorDocIds.length === 0) return []
  return getDb().projectChunks.where("vectorDocId").anyOf(vectorDocIds).toArray()
}

export async function listProjectChunksByFile(
  projectId: string,
  fileId: string
): Promise<ProjectChunk[]> {
  return getDb().projectChunks.where("[projectId+fileId]").equals([projectId, fileId]).toArray()
}

export async function listProjectChunksByProject(
  projectId: string,
  options?: { limit?: number; offset?: number }
): Promise<ProjectChunk[]> {
  let coll = getDb().projectChunks.where("projectId").equals(projectId)
  if (options?.offset) coll = coll.offset(options.offset)
  if (options?.limit) coll = coll.limit(options.limit)
  return coll.toArray()
}

export async function countProjectChunksByProject(projectId: string): Promise<number> {
  return getDb().projectChunks.where("projectId").equals(projectId).count()
}

export async function countProjectChunksByFile(projectId: string, fileId: string): Promise<number> {
  return getDb().projectChunks.where("[projectId+fileId]").equals([projectId, fileId]).count()
}

/**
 * Content hash of a file's currently-indexed chunks, or `undefined` when the
 * file has no chunks. All chunks of one file share the same `contentHash`, so
 * the first row's hash is the file's hash. Used by the ingest driver to skip
 * re-embedding a file whose content is unchanged.
 */
export async function getIndexedContentHash(
  projectId: string,
  fileId: string
): Promise<string | undefined> {
  const first = await getDb()
    .projectChunks.where("[projectId+fileId]")
    .equals([projectId, fileId])
    .first()
  return first?.contentHash
}

/**
 * Cheap content-version signal for a project's chunk corpus — `count` plus the
 * newest `createdAt`. Both reads ride existing indexes (`projectId` count + the
 * `[projectId+createdAt]` compound for the newest row). Mirrors
 * `getTwinChunksVersion`.
 */
export async function getProjectChunksVersion(
  projectId: string
): Promise<{ count: number; latestCreatedAt: number }> {
  const db = getDb()
  const count = await db.projectChunks.where("projectId").equals(projectId).count()
  if (count === 0) return { count: 0, latestCreatedAt: 0 }
  const newest = await db.projectChunks
    .where("[projectId+createdAt]")
    .between([projectId, Dexie.minKey], [projectId, Dexie.maxKey])
    .last()
  return { count, latestCreatedAt: newest?.createdAt ?? 0 }
}

export async function deleteProjectChunk(id: string): Promise<void> {
  await getDb().projectChunks.delete(id)
}

export async function deleteProjectChunksByFile(
  projectId: string,
  fileId: string
): Promise<number> {
  return getDb().projectChunks.where("[projectId+fileId]").equals([projectId, fileId]).delete()
}

export async function deleteProjectChunksByProject(projectId: string): Promise<number> {
  return getDb().projectChunks.where("projectId").equals(projectId).delete()
}
