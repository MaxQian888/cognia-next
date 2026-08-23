/** Persistence and ownership guards for reusable Agent Knowledge Bases. */

import type {
  KnowledgeBase,
  KnowledgeBaseChunk,
  KnowledgeBaseIngestJob,
  KnowledgeBaseReference,
  KnowledgeBaseSource,
} from "@/types/knowledge-base"
import { getDb, withDbReopenRetry } from "./schema"

function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

function cleanOptionalText(value: string | undefined): string | undefined {
  const cleaned = value?.trim()
  return cleaned ? cleaned : undefined
}

async function requireKnowledgeBase(id: string): Promise<void> {
  if (!(await getDb().knowledgeBases.get(id))) {
    throw new Error(`Knowledge Base ${id} not found`)
  }
}

export type KnowledgeBaseDraft = Pick<KnowledgeBase, "name"> &
  Partial<Pick<KnowledgeBase, "id" | "description">> & { now?: number }

export async function createKnowledgeBase(draft: KnowledgeBaseDraft): Promise<KnowledgeBase> {
  const name = draft.name.trim()
  if (!name) throw new Error("Knowledge Base name is required")
  const now = draft.now ?? Date.now()
  const row: KnowledgeBase = {
    id: draft.id ?? newId("kb"),
    name,
    description: cleanOptionalText(draft.description),
    createdAt: now,
    updatedAt: now,
  }
  await getDb().knowledgeBases.add(row)
  return row
}

export async function listKnowledgeBases(): Promise<KnowledgeBase[]> {
  return getDb().knowledgeBases.orderBy("updatedAt").reverse().toArray()
}

export async function getKnowledgeBasesByIds(ids: readonly string[]): Promise<KnowledgeBase[]> {
  if (ids.length === 0) return []
  const rows = await getDb().knowledgeBases.bulkGet([...ids])
  return rows.filter((row): row is KnowledgeBase => row !== undefined)
}

export async function updateKnowledgeBase(
  id: string,
  patch: Partial<Pick<KnowledgeBase, "name" | "description">>,
  now = Date.now()
): Promise<KnowledgeBase | undefined> {
  const cleaned: Partial<KnowledgeBase> = { updatedAt: now }
  if (patch.name !== undefined) {
    const name = patch.name.trim()
    if (!name) throw new Error("Knowledge Base name is required")
    cleaned.name = name
  }
  if (patch.description !== undefined) cleaned.description = cleanOptionalText(patch.description)
  await getDb().knowledgeBases.update(id, cleaned)
  return getDb().knowledgeBases.get(id)
}

export type KnowledgeBaseSourceDraft = Pick<
  KnowledgeBaseSource,
  "knowledgeBaseId" | "kind" | "format" | "title" | "content" | "fingerprint"
> &
  Partial<
    Pick<
      KnowledgeBaseSource,
      | "id"
      | "contentEncoding"
      | "originalLocation"
      | "bytes"
      | "status"
      | "chunkCount"
      | "errorCode"
      | "acl"
    >
  > & { now?: number }

export async function createKnowledgeBaseSource(
  draft: KnowledgeBaseSourceDraft
): Promise<KnowledgeBaseSource> {
  await requireKnowledgeBase(draft.knowledgeBaseId)
  const title = draft.title.trim()
  if (!title) throw new Error("Knowledge Base source title is required")
  const now = draft.now ?? Date.now()
  const row: KnowledgeBaseSource = {
    id: draft.id ?? newId("kbs"),
    knowledgeBaseId: draft.knowledgeBaseId,
    kind: draft.kind,
    format: draft.format,
    title,
    content: draft.content,
    contentEncoding: draft.contentEncoding,
    originalLocation: cleanOptionalText(draft.originalLocation),
    bytes: draft.bytes ?? new TextEncoder().encode(draft.content).byteLength,
    fingerprint: draft.fingerprint,
    status: draft.status ?? "pending",
    chunkCount: draft.chunkCount ?? 0,
    errorCode: cleanOptionalText(draft.errorCode),
    acl: draft.acl,
    createdAt: now,
    updatedAt: now,
  }
  await getDb().knowledgeBaseSources.add(row)
  await getDb().knowledgeBases.update(row.knowledgeBaseId, { updatedAt: now })
  return row
}

export async function listKnowledgeBaseSources(
  knowledgeBaseId: string
): Promise<KnowledgeBaseSource[]> {
  return getDb()
    .knowledgeBaseSources.where("[knowledgeBaseId+updatedAt]")
    .between([knowledgeBaseId, -Infinity], [knowledgeBaseId, Infinity])
    .reverse()
    .toArray()
}

export async function getKnowledgeBaseSourcesByIds(
  ids: readonly string[]
): Promise<KnowledgeBaseSource[]> {
  if (ids.length === 0) return []
  const rows = await getDb().knowledgeBaseSources.bulkGet([...ids])
  return rows.filter((row): row is KnowledgeBaseSource => row !== undefined)
}

export async function updateKnowledgeBaseSource(
  id: string,
  patch: Partial<Pick<KnowledgeBaseSource, "status" | "chunkCount" | "errorCode" | "acl">>,
  now = Date.now()
): Promise<KnowledgeBaseSource | undefined> {
  await getDb().knowledgeBaseSources.update(id, {
    ...patch,
    errorCode: cleanOptionalText(patch.errorCode),
    updatedAt: now,
  })
  return getDb().knowledgeBaseSources.get(id)
}

export async function deleteKnowledgeBaseSource(id: string): Promise<void> {
  await withDbReopenRetry(async () => {
    const db = getDb()
    const source = await db.knowledgeBaseSources.get(id)
    if (!source) return
    await db.transaction(
      "rw",
      db.knowledgeBases,
      db.knowledgeBaseSources,
      db.knowledgeBaseChunks,
      db.knowledgeBaseIngestJobs,
      async () => {
        await Promise.all([
          db.knowledgeBaseChunks.where("sourceId").equals(id).delete(),
          db.knowledgeBaseIngestJobs.where("sourceId").equals(id).delete(),
          db.knowledgeBaseSources.delete(id),
          db.knowledgeBases.update(source.knowledgeBaseId, { updatedAt: Date.now() }),
        ])
      }
    )
  })
}

export async function putKnowledgeBaseChunks(rows: readonly KnowledgeBaseChunk[]): Promise<void> {
  if (rows.length === 0) return
  const db = getDb()
  const sources = await db.knowledgeBaseSources.bulkGet([
    ...new Set(rows.map((row) => row.sourceId)),
  ])
  const sourceById = new Map(sources.filter(Boolean).map((source) => [source!.id, source!]))
  for (const row of rows) {
    const source = sourceById.get(row.sourceId)
    if (!source || source.knowledgeBaseId !== row.knowledgeBaseId) {
      throw new Error(`Knowledge Base chunk ${row.id} has an invalid source ownership`)
    }
  }
  await db.knowledgeBaseChunks.bulkPut([...rows])
}

export async function listKnowledgeBaseChunks(
  knowledgeBaseId: string
): Promise<KnowledgeBaseChunk[]> {
  return getDb().knowledgeBaseChunks.where("knowledgeBaseId").equals(knowledgeBaseId).toArray()
}

/** Resolve either an explicit immutable revision set or each source's current channel. */
export async function listKnowledgeBaseRevisionChunks(
  knowledgeBaseId: string,
  generationIds?: readonly string[]
): Promise<KnowledgeBaseChunk[]> {
  const rows = await listKnowledgeBaseChunks(knowledgeBaseId)
  if (generationIds) {
    const allowed = new Set(generationIds)
    return rows.filter((row) => row.generationId && allowed.has(row.generationId))
  }
  const sourceIds = [...new Set(rows.map((row) => row.sourceId))]
  const db = getDb()
  const pointers = await db.retrievalActivePointers.bulkGet(
    sourceIds.map((sourceId) => `knowledge_base:${knowledgeBaseId}:source:${sourceId}`)
  )
  const activeBySourceId = new Map(
    pointers.flatMap((pointer, index) =>
      pointer ? ([[sourceIds[index], pointer.generationId]] as const) : []
    )
  )
  return rows.filter((row) => {
    const active = activeBySourceId.get(row.sourceId)
    return active ? row.generationId === active : true
  })
}

export async function listKnowledgeBaseVectorCollections(
  knowledgeBaseId: string
): Promise<string[]> {
  const rows = await getDb()
    .knowledgeBaseChunks.where("knowledgeBaseId")
    .equals(knowledgeBaseId)
    .toArray()
  return [...new Set(rows.map((row) => row.vectorCollection).filter(Boolean))].sort()
}

export async function listKnowledgeBaseChunksBySource(
  sourceId: string
): Promise<KnowledgeBaseChunk[]> {
  return getDb().knowledgeBaseChunks.where("sourceId").equals(sourceId).toArray()
}

export async function deleteKnowledgeBaseChunksBySource(sourceId: string): Promise<number> {
  return getDb().knowledgeBaseChunks.where("sourceId").equals(sourceId).delete()
}

export async function getKnowledgeBaseChunksByVectorDocIds(
  knowledgeBaseId: string,
  vectorDocIds: readonly string[]
): Promise<KnowledgeBaseChunk[]> {
  if (vectorDocIds.length === 0) return []
  const rows = await getDb()
    .knowledgeBaseChunks.where("vectorDocId")
    .anyOf([...vectorDocIds])
    .toArray()
  return rows.filter((row) => row.knowledgeBaseId === knowledgeBaseId)
}

export type KnowledgeBaseIngestJobDraft = Pick<
  KnowledgeBaseIngestJob,
  "knowledgeBaseId" | "sourceId"
> &
  Partial<Pick<KnowledgeBaseIngestJob, "id">> & { now?: number }

export async function createKnowledgeBaseIngestJob(
  draft: KnowledgeBaseIngestJobDraft
): Promise<KnowledgeBaseIngestJob> {
  const source = await getDb().knowledgeBaseSources.get(draft.sourceId)
  if (!source || source.knowledgeBaseId !== draft.knowledgeBaseId) {
    throw new Error("Knowledge Base ingest job source ownership does not match")
  }
  const now = draft.now ?? Date.now()
  const row: KnowledgeBaseIngestJob = {
    id: draft.id ?? newId("kbj"),
    knowledgeBaseId: draft.knowledgeBaseId,
    sourceId: draft.sourceId,
    status: "queued",
    phase: "queued",
    progress: 0,
    attempts: 0,
    queuedAt: now,
    updatedAt: now,
  }
  await getDb().knowledgeBaseIngestJobs.add(row)
  return row
}

export async function updateKnowledgeBaseIngestJob(
  id: string,
  patch: Partial<
    Pick<
      KnowledgeBaseIngestJob,
      "status" | "phase" | "progress" | "attempts" | "startedAt" | "completedAt" | "errorCode"
    >
  >,
  now = Date.now()
): Promise<KnowledgeBaseIngestJob | undefined> {
  if (patch.progress !== undefined && (patch.progress < 0 || patch.progress > 100)) {
    throw new Error("Knowledge Base ingest progress must be between 0 and 100")
  }
  await getDb().knowledgeBaseIngestJobs.update(id, { ...patch, updatedAt: now })
  return getDb().knowledgeBaseIngestJobs.get(id)
}

export async function listKnowledgeBaseIngestJobs(
  knowledgeBaseId: string
): Promise<KnowledgeBaseIngestJob[]> {
  return getDb()
    .knowledgeBaseIngestJobs.where("[knowledgeBaseId+updatedAt]")
    .between([knowledgeBaseId, -Infinity], [knowledgeBaseId, Infinity])
    .reverse()
    .toArray()
}

export async function getKnowledgeBaseReferences(
  knowledgeBaseId: string
): Promise<KnowledgeBaseReference[]> {
  const db = getDb()
  const [characters, workflows] = await Promise.all([
    db.characters.toArray(),
    db.workflows.toArray(),
  ])
  return [
    ...characters
      .filter((row) => row.knowledgeBaseIds?.includes(knowledgeBaseId))
      .map((row) => ({ kind: "agent" as const, id: row.id, name: row.name })),
    ...workflows
      .filter((row) => row.knowledgeBaseIds?.includes(knowledgeBaseId))
      .map((row) => ({ kind: "workflow" as const, id: row.id, name: row.name })),
  ]
}

export class KnowledgeBaseInUseError extends Error {
  readonly code = "knowledge_base_in_use"

  constructor(readonly references: KnowledgeBaseReference[]) {
    super("Knowledge Base is still referenced")
    this.name = "KnowledgeBaseInUseError"
  }
}

export async function deleteKnowledgeBase(
  id: string,
  options: { detachReferences?: boolean; now?: number } = {}
): Promise<{ detachedReferences: KnowledgeBaseReference[] }> {
  const references = await getKnowledgeBaseReferences(id)
  if (references.length > 0 && !options.detachReferences) {
    throw new KnowledgeBaseInUseError(references)
  }

  await withDbReopenRetry(async () => {
    const db = getDb()
    await db.transaction(
      "rw",
      [
        db.knowledgeBases,
        db.knowledgeBaseSources,
        db.knowledgeBaseChunks,
        db.knowledgeBaseIngestJobs,
        db.characters,
        db.workflows,
      ],
      async () => {
        const now = options.now ?? Date.now()
        if (options.detachReferences) {
          await Promise.all([
            ...references
              .filter((reference) => reference.kind === "agent")
              .map(async (reference) => {
                const row = await db.characters.get(reference.id)
                if (!row) return
                await db.characters.update(reference.id, {
                  knowledgeBaseIds: (row.knowledgeBaseIds ?? []).filter(
                    (value: string) => value !== id
                  ),
                  updatedAt: now,
                })
              }),
            ...references
              .filter((reference) => reference.kind === "workflow")
              .map(async (reference) => {
                const row = await db.workflows.get(reference.id)
                if (!row) return
                await db.workflows.update(reference.id, {
                  knowledgeBaseIds: (row.knowledgeBaseIds ?? []).filter((value) => value !== id),
                  updatedAt: now,
                })
              }),
          ])
        }
        await Promise.all([
          db.knowledgeBaseIngestJobs.where("knowledgeBaseId").equals(id).delete(),
          db.knowledgeBaseChunks.where("knowledgeBaseId").equals(id).delete(),
          db.knowledgeBaseSources.where("knowledgeBaseId").equals(id).delete(),
          db.knowledgeBases.delete(id),
        ])
      }
    )
  })

  return { detachedReferences: references }
}
