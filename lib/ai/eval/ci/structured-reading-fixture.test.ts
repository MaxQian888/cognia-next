import { createLongDocumentFixture } from "@cognia/eval-core/fixtures/long-document"
import { processDocument } from "@cognia/document/document-processor"
import { prepareChunks } from "@/lib/twin/ingest/chunk"
import { createDbTestFixture } from "@/lib/db/test-fixture"
import { getDb } from "@/lib/db/schema"
import {
  createKnowledgeBase,
  createKnowledgeBaseSource,
  deleteKnowledgeBaseSource,
  putKnowledgeBaseChunks,
} from "@/lib/db/knowledge-bases"
import {
  retrieveKnowledgeBaseChunks,
  type KnowledgeBaseRuntimeDeps,
} from "@/lib/knowledge-base/runtime/retrieve"
import { createKnowledgeReader } from "@/lib/knowledge-base/runtime/progressive-reading"
import type { KnowledgeBaseChunk, KnowledgeBaseDocumentSnapshot } from "@/types/knowledge-base"
import {
  runStructuredReadingEvaluation,
  STRUCTURED_READING_ABSTENTION,
} from "./structured-reading-fixture"

const kb = "structured-reading-fixture"
const fixture = createLongDocumentFixture()
const dbFixture = createDbTestFixture({ seeded: false })
beforeAll(dbFixture.initialize)
beforeEach(dbFixture.restore)
afterAll(dbFixture.dispose)

async function installFixture(
  revision: 1 | 2 = 1,
  indexedText: "original" | "embedding" = "original"
) {
  const input = createLongDocumentFixture({ revision })
  const document = processDocument(input.id, input.filename, input.originalText)
  const generationId = `fixture-generation-${revision}`
  const corpusId = `knowledge_base:${kb}:source:${input.id}`
  const snapshot: KnowledgeBaseDocumentSnapshot = {
    generationId,
    contentHash: document.structure!.contentHash,
    originalText: document.content,
    structure: document.structure,
    title: input.filename,
    format: "markdown",
    createdAt: revision,
  }
  const indexContent = indexedText === "original" ? document.content : document.embeddableContent
  const prepared = prepareChunks({
    originalText: indexContent,
    redactedText: indexContent,
    format: "markdown",
    options: { chunkSize: 800, chunkOverlap: 0 },
  })
  const rows: KnowledgeBaseChunk[] = prepared.map((chunk, index) => ({
    ...chunk,
    id: `${generationId}-chunk-${index}`,
    knowledgeBaseId: kb,
    sourceId: input.id,
    generationId,
    contentRedacted: chunk.content,
    vectorBackend: "native",
    vectorCollection: `fixture-collection-${revision}`,
    vectorDocId: `${generationId}-vector-${index}`,
    contentHash: snapshot.contentHash,
    createdAt: revision,
  }))
  if (revision === 1) {
    await createKnowledgeBase({ id: kb, name: "Evaluation fixture", now: 1 })
    await createKnowledgeBaseSource({
      id: input.id,
      knowledgeBaseId: kb,
      kind: "document",
      format: "markdown",
      title: input.filename,
      content: input.originalText,
      fingerprint: snapshot.contentHash,
      status: "ready",
      acl: { visibility: "public" },
      now: 1,
    })
  }
  const db = getDb()
  const source = (await db.knowledgeBaseSources.get(input.id))!
  await db.knowledgeBaseSources.update(input.id, {
    generationSnapshots: { ...source.generationSnapshots, [generationId]: snapshot },
  })
  if (revision === 2)
    await db.retrievalGenerations.update("fixture-generation-1", { status: "retiring" })
  await db.retrievalGenerations.put({
    id: generationId,
    corpusId,
    domain: "kb",
    profileFingerprint: "deterministic-fixture",
    status: "active",
    createdAt: revision,
    validation: { valid: true, count: rows.length, contentHash: snapshot.contentHash },
  })
  await db.retrievalActivePointers.put({
    corpusId,
    generationId,
    domain: "kb",
    profileFingerprint: "deterministic-fixture",
    updatedAt: revision,
  })
  await putKnowledgeBaseChunks(rows)
  const deps: KnowledgeBaseRuntimeDeps = {
    vectorBackend: "native",
    embedding: { provider: "openai", model: "text-embedding-3-small", apiKey: "unused-no-network" },
    store: {
      getCollectionInfo: async (name) => ({ name, dimension: 3, documentCount: rows.length }),
      // Deterministic vector boundary: give recovery chunks the highest score.
      searchByEmbedding: async (collection, _embedding, options) =>
        rows
          .filter((row) => row.vectorCollection === collection)
          .map((row) => ({
            id: row.vectorDocId,
            content: row.content,
            score: row.content.includes("recovery approval owner")
              ? 3
              : row.content.includes("choosing a recovery delay")
                ? 2
                : 0.1,
          }))
          .sort((a, b) => b.score - a.score)
          .slice(0, options?.limit ?? rows.length),
    },
  }
  return { input, document, snapshot, rows, deps }
}

describe("structured reading deterministic evaluation", () => {
  it.each(["vector", "keyword", "hybrid"] as const)(
    "compares %s fast context with executed original section reads and reused RAG scores",
    async (strategy) => {
      const { input, deps } = await installFixture()
      const reader = createKnowledgeReader({ knowledgeBaseIds: [kb], settings: { enabled: true } })
      const documents = await reader.listDocuments()
      expect(documents.documents).toHaveLength(1)
      const identity = documents.documents[0]
      const outline = await reader.readOutline(identity)
      const results = await runStructuredReadingEvaluation(input, {
        retrieveFast: async (query) => {
          const result = await retrieveKnowledgeBaseChunks({
            knowledgeBaseId: kb,
            userMessage: query,
            topK: 3,
            strategy,
            tokenBudget: 1000,
            precomputedQueryEmbedding: [1, 0, 0],
            deps,
          })
          expect(result.degraded).toBe(false)
          return result.chunks.map(({ chunk, score }) => ({
            id: chunk.id,
            text: chunk.content,
            score,
          }))
        },
        readOriginal: async (sectionTitle) => {
          const section = outline.nodes.find((node) => node.title === sectionTitle)!
          const read = await reader.readRange({ ...identity, sectionId: section.id })
          expect(read.text).toBe(input.originalText.slice(read.charStart, read.charEnd))
          return [{ id: section.id, text: read.text }]
        },
      })
      const codeFast = results.find(
        (result) => result.caseId === "code-configuration" && result.mode === "fast-rag"
      )!
      const codeRead = results.find(
        (result) => result.caseId === "code-configuration" && result.mode === "progressive"
      )!
      expect(codeFast.recall.value).toBe(1)
      expect(codeFast.answerCorrect).toBe(true)
      expect(codeRead.recall.value).toBe(1)
      expect(codeRead.answerCorrect).toBe(true)
      expect(codeRead.faithfulness.passed).toBe(true)
      expect(
        results
          .filter(({ caseId }) => caseId === "prose-approval")
          .every(({ answerCorrect }) => answerCorrect)
      ).toBe(true)
      expect(
        results
          .filter(({ mode }) => mode === "progressive")
          .every(({ answerCorrect }) => answerCorrect)
      ).toBe(true)
      expect(
        results
          .filter(({ caseId }) => caseId === "unsupported-policy")
          .every(({ abstained }) => abstained)
      ).toBe(true)
      expect(reader.budget().readChars).toBeLessThan(input.originalText.length / 100)
      expect(results.every(({ sample }) => sample.costUsd === 0)).toBe(true)
      if (process.env.COGNIA_STRUCTURED_READING_REPORT === "1") {
        process.stdout.write(
          JSON.stringify({
            fixture: input.id,
            strategy,
            originalChars: input.originalText.length,
            progressiveReadChars: reader.budget().readChars,
            syntheticAnswerAndJudge: true,
            modelCalls: 0,
            results: results.map(
              ({ caseId, mode, recall, faithfulness, answerCorrect, abstained }) => ({
                caseId,
                mode,
                contextRecall: recall.status === "scored" ? recall.value : null,
                faithfulness: faithfulness.status === "scored" ? faithfulness.value : null,
                answerCorrect,
                abstained,
              })
            ),
          }) + "\n"
        )
      }
    }
  )

  it("recovers code evidence from original snapshots when legacy embedding projections omit it", async () => {
    const { input, deps } = await installFixture(1, "embedding")
    const reader = createKnowledgeReader({ knowledgeBaseIds: [kb], settings: { enabled: true } })
    const identity = { knowledgeBaseId: kb, sourceId: input.id }
    const outline = await reader.readOutline(identity)
    const results = await runStructuredReadingEvaluation(input, {
      retrieveFast: async (userMessage) => {
        const result = await retrieveKnowledgeBaseChunks({
          knowledgeBaseId: kb,
          userMessage,
          topK: 3,
          strategy: "keyword",
          tokenBudget: 1000,
          deps,
        })
        return result.chunks.map(({ chunk }) => ({ id: chunk.id, text: chunk.content }))
      },
      readOriginal: async (title) => {
        const section = outline.nodes.find((node) => node.title === title)!
        return [{ text: (await reader.readRange({ ...identity, sectionId: section.id })).text }]
      },
    })
    const code = results.filter(({ caseId }) => caseId === "code-configuration")
    expect(code.find(({ mode }) => mode === "fast-rag")).toMatchObject({
      answerCorrect: false,
      abstained: true,
      recall: { value: 0 },
    })
    expect(code.find(({ mode }) => mode === "progressive")).toMatchObject({
      answerCorrect: true,
      recall: { value: 1 },
    })
  })

  it("honors configured read and retrieval budgets rather than scoring unseen original text", async () => {
    const { input, document, deps } = await installFixture()
    const section = document.structure!.nodes.find(
      (node) => node.title === "Recovery configuration"
    )!
    const reader = createKnowledgeReader({
      knowledgeBaseIds: [kb],
      settings: { enabled: true, maxReadChars: 12, totalReadChars: 12 },
    })
    const read = await reader.readRange({
      knowledgeBaseId: kb,
      sourceId: input.id,
      sectionId: section.id,
    })
    expect(read.text).toHaveLength(12)
    expect(read.nextCharStart).toBe(read.charEnd)
    await expect(
      reader.readRange({ knowledgeBaseId: kb, sourceId: input.id, sectionId: section.id })
    ).rejects.toMatchObject({ code: "read_budget_exhausted" })
    const results = await runStructuredReadingEvaluation(input, {
      retrieveFast: async (userMessage) => {
        const result = await retrieveKnowledgeBaseChunks({
          knowledgeBaseId: kb,
          userMessage,
          strategy: "keyword",
          topK: 3,
          tokenBudget: 0,
          deps,
        })
        return result.chunks.map(({ chunk }) => ({ text: chunk.content }))
      },
      readOriginal: async () => [{ text: read.text }],
    })
    expect(
      results
        .filter(({ caseId }) => caseId !== "unsupported-policy")
        .every(({ answerCorrect }) => !answerCorrect)
    ).toBe(true)
  })

  it("reads current and retained historical revisions, then rejects deleted sources and permits a rebuilt source", async () => {
    const before = await installFixture()
    const sectionId = before.document.structure!.nodes.find(
      (node) => node.title === "Recovery configuration"
    )!.id
    const after = await installFixture(2)
    const reader = createKnowledgeReader({ knowledgeBaseIds: [kb], settings: { enabled: true } })
    const request = { knowledgeBaseId: kb, sourceId: fixture.id, sectionId }
    const historical = await reader.readRange({ ...request, generationId: "fixture-generation-1" })
    expect(historical.text).toContain("recovery_delay_seconds = 47")
    expect(historical.versionStatus).toBe("historical")
    const current = await reader.readRange(request)
    expect(current.text).toContain("recovery_delay_seconds = 61")
    expect(current.versionStatus).toBe("current")
    expect(
      after.document.structure!.nodes.find((node) => node.title === "Recovery configuration")!.id
    ).toBe(sectionId)
    await deleteKnowledgeBaseSource(fixture.id)
    await expect(
      reader.readRange({ ...request, generationId: "fixture-generation-1" })
    ).rejects.toMatchObject({ code: "source_unavailable" })
    expect(await getDb().retrievalGenerations.toArray()).toHaveLength(0)
    expect(await getDb().knowledgeBaseChunks.toArray()).toHaveLength(0)
    expect(await getDb().retrievalActivePointers.toArray()).toHaveLength(0)
    expect(await getDb().knowledgeBaseSources.get(fixture.id)).toBeUndefined()
    await getDb().knowledgeBases.delete(kb)
    await installFixture()
    expect((await reader.readRange(request)).text).toContain("recovery_delay_seconds = 47")
  })

  it("enforces source scope and live ACL revocation before returning original text", async () => {
    await installFixture()
    const reader = createKnowledgeReader({
      knowledgeBaseIds: [kb],
      entrypoint: "http",
      settings: { enabled: true },
    })
    const request = { knowledgeBaseId: kb, sourceId: fixture.id, maxChars: 10 }
    expect((await reader.listDocuments()).documents).toHaveLength(1)
    await getDb().knowledgeBaseSources.update(fixture.id, { acl: { visibility: "private" } })
    await expect(reader.readRange(request)).rejects.toMatchObject({ code: "source_unavailable" })
    expect((await reader.listDocuments()).documents).toHaveLength(0)
    await expect(
      reader.readRange({ ...request, knowledgeBaseId: "outside-selected-scope" })
    ).rejects.toMatchObject({ code: "source_unavailable" })
  })

  it("scores recall and abstention separately without invoking an external judge", async () => {
    const results = await runStructuredReadingEvaluation(fixture, {
      retrieveFast: async () => [],
      readOriginal: async () => [],
    })
    expect(results).toHaveLength(6)
    expect(results.every(({ sample }) => sample.costUsd === 0)).toBe(true)
    expect(
      results
        .filter(({ caseId }) => caseId === "unsupported-policy")
        .every(
          ({ answerCorrect, recall, sample }) =>
            answerCorrect &&
            recall.status === "not-applicable" &&
            sample.output === STRUCTURED_READING_ABSTENTION
        )
    ).toBe(true)
    expect(
      results
        .filter(({ caseId }) => caseId !== "unsupported-policy")
        .every(({ answerCorrect, recall }) => !answerCorrect && recall.value === 0)
    ).toBe(true)
  })

  it("uses actual parser, chunker, revision filtering, and configurable keyword retrieval", async () => {
    const { input, document, deps } = await installFixture()
    expect(document.content).toBe(input.originalText)
    expect(document.embeddableContent).not.toContain("recovery_delay_seconds = 47")
    const result = await retrieveKnowledgeBaseChunks({
      knowledgeBaseId: kb,
      userMessage: "recovery approval owner",
      topK: 3,
      strategy: "keyword",
      tokenBudget: 1000,
      deps,
    })
    expect(result.degraded).toBe(false)
    expect(result.chunks.some(({ chunk }) => chunk.content.includes("Cedar operations"))).toBe(true)
    expect(result.chunks.every(({ chunk }) => chunk.generationId === "fixture-generation-1")).toBe(
      true
    )
  })

  it("propagates adapter failures instead of reporting a successful evaluation", async () => {
    await expect(
      runStructuredReadingEvaluation(fixture, {
        retrieveFast: async () => {
          throw new Error("fixture adapter offline")
        },
        readOriginal: async () => [],
      })
    ).rejects.toThrow("fixture adapter offline")
  })
})
