import type { Character } from "@cognia/agent-config-types"
import type { WorkflowRow } from "@/types/workflow/visual"
import { createDbTestFixture } from "./test-fixture"
import { getDb } from "./schema"
import {
  KnowledgeBaseInUseError,
  createKnowledgeBase,
  createKnowledgeBaseIngestJob,
  createKnowledgeBaseSource,
  deleteKnowledgeBase,
  deleteKnowledgeBaseSource,
  getKnowledgeBasesByIds,
  getKnowledgeBaseChunksByVectorDocIds,
  getKnowledgeBaseReferences,
  getKnowledgeBaseSourcesByIds,
  listKnowledgeBaseChunks,
  listKnowledgeBaseIngestJobs,
  listKnowledgeBaseSources,
  listKnowledgeBases,
  putKnowledgeBaseChunks,
  updateKnowledgeBase,
  updateKnowledgeBaseIngestJob,
} from "./knowledge-bases"

const dbFixture = createDbTestFixture({
  emptyTables: [
    "knowledgeBases",
    "knowledgeBaseSources",
    "knowledgeBaseChunks",
    "knowledgeBaseIngestJobs",
  ],
})

beforeAll(dbFixture.initialize)
beforeEach(dbFixture.restore)
afterAll(dbFixture.dispose)

describe("knowledge base persistence", () => {
  it("creates, updates, and lists reusable libraries by recency", async () => {
    const first = await createKnowledgeBase({
      id: "kb-first",
      name: " First library ",
      description: " docs ",
      now: 10,
    })
    await createKnowledgeBase({ id: "kb-second", name: "Second", now: 20 })

    expect(first).toEqual({
      id: "kb-first",
      name: "First library",
      description: "docs",
      createdAt: 10,
      updatedAt: 10,
    })
    expect((await listKnowledgeBases()).map((row) => row.id)).toEqual(["kb-second", "kb-first"])

    await updateKnowledgeBase("kb-first", { name: "Renamed", description: "" }, 30)
    const updated = await getDb().knowledgeBases.get("kb-first")
    expect(updated).toEqual(expect.objectContaining({ name: "Renamed", updatedAt: 30 }))
    expect(updated?.description).toBeUndefined()
  })

  it("supports generated ids, batch reads, and validation boundaries", async () => {
    await expect(createKnowledgeBase({ name: " " })).rejects.toThrow("name is required")
    const generated = await createKnowledgeBase({ name: "Generated" })
    expect(generated.id).toMatch(/^kb_/)
    expect(await getKnowledgeBasesByIds([])).toEqual([])
    expect((await getKnowledgeBasesByIds([generated.id, "missing"])).map((row) => row.id)).toEqual([
      generated.id,
    ])
    await expect(updateKnowledgeBase(generated.id, { name: " " })).rejects.toThrow(
      "name is required"
    )
    await expect(
      createKnowledgeBaseSource({
        knowledgeBaseId: "missing",
        kind: "document",
        format: "markdown",
        title: "Guide",
        content: "text",
        fingerprint: "missing",
      })
    ).rejects.toThrow("not found")
    await expect(
      createKnowledgeBaseSource({
        knowledgeBaseId: generated.id,
        kind: "document",
        format: "markdown",
        title: " ",
        content: "text",
        fingerprint: "blank-title",
      })
    ).rejects.toThrow("title is required")
    await expect(deleteKnowledgeBase(generated.id)).resolves.toEqual({ detachedReferences: [] })
  })

  it("persists sources, derived chunks, and durable ingest jobs", async () => {
    await createKnowledgeBase({ id: "kb-1", name: "Product", now: 1 })
    const source = await createKnowledgeBaseSource({
      id: "source-1",
      knowledgeBaseId: "kb-1",
      kind: "document",
      format: "markdown",
      title: "Guide",
      content: "hello world",
      fingerprint: "sha256:one",
      now: 2,
    })
    await putKnowledgeBaseChunks([
      {
        id: "chunk-1",
        knowledgeBaseId: "kb-1",
        sourceId: source.id,
        content: "hello world",
        contentRedacted: "hello world",
        charStart: 0,
        charEnd: 11,
        vectorBackend: "native",
        vectorCollection: "cognia_kb_kb-1",
        vectorDocId: "kb-1__source-1__0",
        strategy: "paragraph",
        tokenCount: 3,
        metadata: { headingPath: ["Guide"] },
        contentHash: "hash-1",
        createdAt: 3,
      },
    ])
    const job = await createKnowledgeBaseIngestJob({
      id: "job-1",
      knowledgeBaseId: "kb-1",
      sourceId: source.id,
      now: 4,
    })
    await updateKnowledgeBaseIngestJob(
      job.id,
      { status: "running", phase: "embedding", progress: 60 },
      5
    )

    expect(await listKnowledgeBaseSources("kb-1")).toEqual([
      expect.objectContaining({ id: "source-1", bytes: 11, status: "pending" }),
    ])
    expect(await listKnowledgeBaseChunks("kb-1")).toEqual([
      expect.objectContaining({ id: "chunk-1", sourceId: "source-1" }),
    ])
    expect(await listKnowledgeBaseIngestJobs("kb-1")).toEqual([
      expect.objectContaining({
        id: "job-1",
        status: "running",
        phase: "embedding",
        progress: 60,
        updatedAt: 5,
      }),
    ])
    expect((await getKnowledgeBaseChunksByVectorDocIds("kb-1", ["kb-1__source-1__0"]))[0].id).toBe(
      "chunk-1"
    )
    expect(await getKnowledgeBaseChunksByVectorDocIds("kb-other", ["kb-1__source-1__0"])).toEqual(
      []
    )
  })

  it("deleting a source removes only its chunks and jobs", async () => {
    await createKnowledgeBase({ id: "kb-1", name: "Product", now: 1 })
    for (const id of ["source-a", "source-b"])
      await createKnowledgeBaseSource({
        id,
        knowledgeBaseId: "kb-1",
        kind: "document",
        format: "markdown",
        title: id,
        content: id,
        fingerprint: id,
        now: 2,
      })
    await putKnowledgeBaseChunks(
      ["source-a", "source-b"].map((sourceId) => ({
        id: `chunk-${sourceId}`,
        knowledgeBaseId: "kb-1",
        sourceId,
        content: sourceId,
        contentRedacted: sourceId,
        charStart: 0,
        charEnd: sourceId.length,
        vectorBackend: "native" as const,
        vectorCollection: "cognia_kb_kb-1",
        vectorDocId: `vector-${sourceId}`,
        strategy: "paragraph" as const,
        tokenCount: 1,
        metadata: {},
        contentHash: sourceId,
        createdAt: 3,
      }))
    )
    for (const sourceId of ["source-a", "source-b"])
      await createKnowledgeBaseIngestJob({
        id: `job-${sourceId}`,
        knowledgeBaseId: "kb-1",
        sourceId,
        now: 4,
      })

    await deleteKnowledgeBaseSource("source-a")

    expect((await listKnowledgeBaseSources("kb-1")).map((row) => row.id)).toEqual(["source-b"])
    expect((await listKnowledgeBaseChunks("kb-1")).map((row) => row.sourceId)).toEqual(["source-b"])
    expect((await listKnowledgeBaseIngestJobs("kb-1")).map((row) => row.sourceId)).toEqual([
      "source-b",
    ])
    await expect(deleteKnowledgeBaseSource("already-gone")).resolves.toBeUndefined()
  })

  it("enforces chunk/job ownership and supports scoped batch lookups", async () => {
    await createKnowledgeBase({ id: "kb-1", name: "One", now: 1 })
    await createKnowledgeBase({ id: "kb-2", name: "Two", now: 1 })
    const source = await createKnowledgeBaseSource({
      id: "source-1",
      knowledgeBaseId: "kb-1",
      kind: "document",
      format: "markdown",
      title: "Guide",
      content: "text",
      fingerprint: "one",
      now: 2,
    })
    expect(await getKnowledgeBaseSourcesByIds([])).toEqual([])
    expect(
      (await getKnowledgeBaseSourcesByIds([source.id, "missing"])).map((row) => row.id)
    ).toEqual([source.id])
    await expect(putKnowledgeBaseChunks([])).resolves.toBeUndefined()
    await expect(
      putKnowledgeBaseChunks([
        {
          id: "invalid",
          knowledgeBaseId: "kb-2",
          sourceId: source.id,
          content: "text",
          contentRedacted: "text",
          charStart: 0,
          charEnd: 4,
          vectorBackend: "native",
          vectorCollection: "cognia_kb_kb-2",
          vectorDocId: "vector-invalid",
          strategy: "paragraph",
          tokenCount: 1,
          metadata: {},
          contentHash: "hash",
          createdAt: 2,
        },
      ])
    ).rejects.toThrow("invalid source ownership")
    expect(await getKnowledgeBaseChunksByVectorDocIds("kb-1", [])).toEqual([])
    await expect(
      createKnowledgeBaseIngestJob({ knowledgeBaseId: "kb-2", sourceId: source.id })
    ).rejects.toThrow("ownership does not match")
    const job = await createKnowledgeBaseIngestJob({
      knowledgeBaseId: "kb-1",
      sourceId: source.id,
    })
    await expect(updateKnowledgeBaseIngestJob(job.id, { progress: 101 })).rejects.toThrow(
      "between 0 and 100"
    )
  })
})

describe("knowledge base deletion guard", () => {
  async function seedReferences() {
    await createKnowledgeBase({ id: "kb-shared", name: "Shared", now: 1 })
    await getDb().characters.put({
      id: "agent-1",
      name: "Research Agent",
      systemPrompt: "Research",
      avatarColor: "blue",
      knowledgeBaseIds: ["kb-shared", "kb-other"],
      createdAt: 1,
      updatedAt: 1,
    } as Character)
    await getDb().workflows.put({
      id: "workflow-1",
      name: "Research flow",
      knowledgeBaseIds: ["kb-shared"],
      createdAt: 1,
      updatedAt: 1,
    } as unknown as WorkflowRow)
  }

  it("reports Agent and workflow references and blocks an accidental delete", async () => {
    await seedReferences()

    expect(await getKnowledgeBaseReferences("kb-shared")).toEqual([
      { kind: "agent", id: "agent-1", name: "Research Agent" },
      { kind: "workflow", id: "workflow-1", name: "Research flow" },
    ])

    await expect(deleteKnowledgeBase("kb-shared")).rejects.toEqual(
      expect.objectContaining<Partial<KnowledgeBaseInUseError>>({
        code: "knowledge_base_in_use",
        references: expect.arrayContaining([
          expect.objectContaining({ kind: "agent", id: "agent-1" }),
          expect.objectContaining({ kind: "workflow", id: "workflow-1" }),
        ]),
      })
    )
    expect(await getDb().knowledgeBases.get("kb-shared")).toBeDefined()
  })

  it("explicit detach removes references and cascades owned rows", async () => {
    await seedReferences()
    await createKnowledgeBaseSource({
      id: "source-1",
      knowledgeBaseId: "kb-shared",
      kind: "document",
      format: "markdown",
      title: "Guide",
      content: "text",
      fingerprint: "one",
      now: 2,
    })
    await createKnowledgeBaseIngestJob({
      id: "job-1",
      knowledgeBaseId: "kb-shared",
      sourceId: "source-1",
      now: 3,
    })

    const result = await deleteKnowledgeBase("kb-shared", { detachReferences: true, now: 9 })

    expect(result.detachedReferences).toHaveLength(2)
    expect(await getDb().knowledgeBases.get("kb-shared")).toBeUndefined()
    expect(await listKnowledgeBaseSources("kb-shared")).toEqual([])
    expect(await listKnowledgeBaseIngestJobs("kb-shared")).toEqual([])
    expect((await getDb().characters.get("agent-1"))?.knowledgeBaseIds).toEqual(["kb-other"])
    expect((await getDb().workflows.get("workflow-1"))?.knowledgeBaseIds).toEqual([])
    expect((await getDb().characters.get("agent-1"))?.updatedAt).toBe(9)
  })
})
