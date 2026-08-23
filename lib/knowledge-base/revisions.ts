import { getDb } from "@/lib/db/schema"
import type { RetrievalGenerationRow } from "@/lib/db/retrieval-control-types"

export function knowledgeBaseSourceCorpusId(knowledgeBaseId: string, sourceId: string): string {
  return `knowledge_base:${knowledgeBaseId}:source:${sourceId}`
}

export async function listKnowledgeBaseSourceRevisions(
  knowledgeBaseId: string,
  sourceId: string
): Promise<RetrievalGenerationRow[]> {
  return getDb()
    .retrievalGenerations.where("corpusId")
    .equals(knowledgeBaseSourceCorpusId(knowledgeBaseId, sourceId))
    .reverse()
    .sortBy("createdAt")
}

export async function assertKnowledgeBaseRevisionBindings(
  knowledgeBaseId: string,
  generationIds: readonly string[]
): Promise<void> {
  if (generationIds.length === 0) return
  const rows = await getDb().retrievalGenerations.bulkGet([...generationIds])
  const prefix = `knowledge_base:${knowledgeBaseId}:source:`
  const invalid = generationIds.filter((id, index) => {
    const row = rows[index]
    return (
      !row ||
      row.domain !== "kb" ||
      !row.corpusId.startsWith(prefix) ||
      !row.validation?.valid ||
      (row.status !== "active" && row.status !== "retiring")
    )
  })
  if (invalid.length > 0) {
    throw new Error(`Frozen Knowledge Base revisions are unavailable: ${invalid.join(", ")}`)
  }
}

export async function resolveCurrentKnowledgeBaseRevisionBindings(
  knowledgeBaseId: string
): Promise<Record<string, string>> {
  const db = getDb()
  const sources = await db.knowledgeBaseSources
    .where("[knowledgeBaseId+updatedAt]")
    .between([knowledgeBaseId, -Infinity], [knowledgeBaseId, Infinity])
    .toArray()
  const pointers = await db.retrievalActivePointers.bulkGet(
    sources.map((source) => knowledgeBaseSourceCorpusId(knowledgeBaseId, source.id))
  )
  const bindings = Object.fromEntries(
    pointers.flatMap((pointer, index) =>
      pointer
        ? [[`knowledge:${knowledgeBaseId}:${sources[index].id}`, pointer.generationId] as const]
        : []
    )
  )
  await assertKnowledgeBaseRevisionBindings(knowledgeBaseId, Object.values(bindings))
  return bindings
}

/** Atomically move one source's controlled `current` channel to a validated revision. */
export async function rollbackKnowledgeBaseSourceRevision(input: {
  knowledgeBaseId: string
  sourceId: string
  generationId: string
  now?: number
}): Promise<RetrievalGenerationRow> {
  const db = getDb()
  const corpusId = knowledgeBaseSourceCorpusId(input.knowledgeBaseId, input.sourceId)
  const now = input.now ?? Date.now()
  return db.transaction("rw", [db.retrievalGenerations, db.retrievalActivePointers], async () => {
    const target = await db.retrievalGenerations.get(input.generationId)
    if (
      !target ||
      target.corpusId !== corpusId ||
      target.domain !== "kb" ||
      !target.validation?.valid ||
      (target.status !== "active" && target.status !== "retiring")
    ) {
      throw new Error("Knowledge Base revision is not a validated revision of this source")
    }
    const pointer = await db.retrievalActivePointers.get(corpusId)
    if (pointer?.generationId === target.id) return target
    const previous = pointer ? await db.retrievalGenerations.get(pointer.generationId) : undefined
    if (previous?.status === "active") {
      await db.retrievalGenerations.put({
        ...previous,
        status: "retiring",
        retiredAt: now,
      })
    }
    const active: RetrievalGenerationRow = {
      ...target,
      status: "active",
      activatedAt: now,
      retiredAt: undefined,
    }
    await db.retrievalGenerations.put(active)
    await db.retrievalActivePointers.put({
      corpusId,
      generationId: active.id,
      domain: "kb",
      profileFingerprint: active.profileFingerprint,
      updatedAt: now,
    })
    return active
  })
}
