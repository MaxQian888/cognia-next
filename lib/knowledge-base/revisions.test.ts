import { createDbTestFixture } from "@/lib/db/test-fixture"
import { getDb } from "@/lib/db/schema"
import type { RetrievalGenerationRow } from "@/lib/db/retrieval-control-types"
import {
  assertKnowledgeBaseRevisionBindings,
  knowledgeBaseSourceCorpusId,
  rollbackKnowledgeBaseSourceRevision,
  resolveCurrentKnowledgeBaseRevisionBindings,
} from "./revisions"

const dbFixture = createDbTestFixture()

beforeAll(dbFixture.initialize)
beforeEach(dbFixture.restore)
afterAll(dbFixture.dispose)

function generation(
  id: string,
  status: RetrievalGenerationRow["status"],
  sourceId = "source-1"
): RetrievalGenerationRow {
  return {
    id,
    corpusId: knowledgeBaseSourceCorpusId("kb-1", sourceId),
    domain: "kb",
    profileFingerprint: "profile",
    status,
    createdAt: id === "old" ? 1 : 2,
    validation: { count: 1, contentHash: id, valid: true },
  }
}

it("atomically rolls current back to a retained validated revision", async () => {
  const db = getDb()
  await db.retrievalGenerations.bulkPut([
    generation("old", "retiring"),
    generation("current", "active"),
  ])
  await db.retrievalActivePointers.put({
    corpusId: knowledgeBaseSourceCorpusId("kb-1", "source-1"),
    generationId: "current",
    domain: "kb",
    profileFingerprint: "profile",
    updatedAt: 2,
  })
  await expect(
    rollbackKnowledgeBaseSourceRevision({
      knowledgeBaseId: "kb-1",
      sourceId: "source-1",
      generationId: "old",
      now: 3,
    })
  ).resolves.toMatchObject({ id: "old", status: "active", activatedAt: 3 })
  expect(await db.retrievalActivePointers.get(generation("old", "active").corpusId)).toMatchObject({
    generationId: "old",
  })
  expect(await db.retrievalGenerations.get("current")).toMatchObject({
    status: "retiring",
    retiredAt: 3,
  })
})

it("rejects missing, cross-library, and failed frozen revisions", async () => {
  const failed = {
    ...generation("failed", "failed"),
    validation: { count: 0, contentHash: "x", valid: false },
  }
  await getDb().retrievalGenerations.bulkPut([
    failed,
    generation("other", "retiring", "source-other"),
  ])

  await expect(assertKnowledgeBaseRevisionBindings("kb-1", ["missing", "failed"])).rejects.toThrow(
    "missing, failed"
  )
  await expect(
    rollbackKnowledgeBaseSourceRevision({
      knowledgeBaseId: "kb-1",
      sourceId: "source-1",
      generationId: "other",
    })
  ).rejects.toThrow("not a validated revision")
})

it("resolves the current channel as source-scoped dependency lock entries", async () => {
  const db = getDb()
  await db.knowledgeBaseSources.put({
    id: "source-1",
    knowledgeBaseId: "kb-1",
    updatedAt: 1,
  } as never)
  await db.retrievalActivePointers.put({
    corpusId: knowledgeBaseSourceCorpusId("kb-1", "source-1"),
    generationId: "current",
    domain: "kb",
    profileFingerprint: "profile",
    updatedAt: 2,
  })
  await db.retrievalGenerations.put(generation("current", "active"))

  await expect(resolveCurrentKnowledgeBaseRevisionBindings("kb-1")).resolves.toEqual({
    "knowledge:kb-1:source-1": "current",
  })
})
