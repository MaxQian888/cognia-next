jest.mock("@cognia/vector/dimension-guard", () => ({
  ensureCollectionDimensionCompatible: jest.fn(async () => undefined),
}))

import { createDbTestFixture } from "@/lib/db/test-fixture"
import { getDb } from "@/lib/db/schema"
import type { KnowledgeFile } from "@/types"
import { countProjectChunksByFile, listProjectChunksByFile } from "@/lib/db/project-chunks"
import { persistProjectChunks, projectVectorCollectionName } from "./persist"
import type { IVectorStore } from "@cognia/vector/store"

const dbFixture = createDbTestFixture()

beforeAll(dbFixture.initialize)
beforeEach(async () => {
  await dbFixture.restore()
}, 30000)

interface AddCall {
  collection: string
  docs: Array<{ id: string; content: string; metadata?: Record<string, unknown> }>
}

function fakeStore() {
  const added: AddCall[] = []
  const deleted: Array<{ collection: string; ids: string[] }> = []
  const created: string[] = []
  const store = {
    provider: "native",
    createCollection: jest.fn(async (name: string) => {
      created.push(name)
    }),
    addDocuments: jest.fn(async (collection: string, docs: AddCall["docs"]) => {
      added.push({ collection, docs })
    }),
    deleteDocuments: jest.fn(async (collection: string, ids: string[]) => {
      deleted.push({ collection, ids })
    }),
  } as unknown as IVectorStore
  return { store, added, deleted, created }
}

function chunk(content: string, redacted = content) {
  return {
    content,
    contentRedacted: redacted,
    charStart: 0,
    charEnd: content.length,
    strategy: "paragraph" as const,
    tokenCount: 1,
    metadata: {},
  }
}

afterAll(dbFixture.dispose)

describe("persistProjectChunks", () => {
  function source(content = "Original"): KnowledgeFile {
    return {
      id: "file-1",
      name: "Guide.md",
      type: "markdown",
      content,
      size: content.length,
      createdAt: new Date(1),
      updatedAt: new Date(1),
    }
  }

  it("rejects a source removed during vector publication without replacing its serving generation", async () => {
    const file = source()
    await getDb().projects.put({ id: "proj-a", knowledgeBase: [file] } as never)
    const { store } = fakeStore()
    const base = {
      projectId: "proj-a",
      fileId: "file-1",
      vectorBackend: "native" as const,
      store,
      contentHash: "hash",
      expectedSource: file,
      chunks: [chunk(file.content!)],
      embeddings: [[1, 2]],
    }
    const first = await persistProjectChunks(base)
    jest.mocked(store.addDocuments).mockImplementationOnce(async () => {
      await getDb().projects.update("proj-a", { knowledgeBase: [] })
    })
    await expect(persistProjectChunks(base)).rejects.toMatchObject({ code: "source_changed" })
    expect((await listProjectChunksByFile("proj-a", "file-1"))[0].generationId).toBe(
      first.generationId
    )
    expect(await getDb().retrievalActivePointers.get("project:proj-a:file:file-1")).toMatchObject({
      generationId: first.generationId,
    })
    expect(store.deleteDocuments).toHaveBeenCalled()
  })

  it("rejects changed text, structure or projection before outbound vector writes", async () => {
    const file = source()
    await getDb().projects.put({
      id: "proj-a",
      knowledgeBase: [{ ...file, embeddableContent: "different projection" }],
    } as never)
    const { store } = fakeStore()
    await expect(
      persistProjectChunks({
        projectId: "proj-a",
        fileId: "file-1",
        vectorBackend: "native",
        store,
        contentHash: "hash",
        expectedSource: file,
        chunks: [chunk(file.content!)],
        embeddings: [[1, 2]],
      })
    ).rejects.toMatchObject({ code: "source_changed" })
    expect(store.addDocuments).not.toHaveBeenCalled()
  })

  it("does not recreate a deleted project after embedding completes", async () => {
    const { store } = fakeStore()
    await expect(
      persistProjectChunks({
        projectId: "deleted",
        fileId: "file-1",
        vectorBackend: "native",
        store,
        contentHash: "hash",
        expectedSource: source(),
        chunks: [],
        embeddings: [],
      })
    ).rejects.toMatchObject({ code: "source_changed" })
    expect(store.addDocuments).not.toHaveBeenCalled()
  })
  it("throws on chunks/embeddings length mismatch", async () => {
    const { store } = fakeStore()
    await expect(
      persistProjectChunks({
        projectId: "p",
        fileId: "f",
        vectorBackend: "native",
        store,
        contentHash: "h",
        chunks: [chunk("a"), chunk("b")],
        embeddings: [[0.1]],
      })
    ).rejects.toThrow(/length mismatch/)
  })

  it("double-writes: remote upsert (redacted payload) + Dexie rows", async () => {
    const { store, added, created } = fakeStore()
    const result = await persistProjectChunks({
      projectId: "proj-a",
      fileId: "file-1",
      vectorBackend: "qdrant",
      store,
      contentHash: "h1",
      chunks: [chunk("original secret", "original <EMAIL_001>")],
      embeddings: [[0.1, 0.2]],
    })

    expect(created).toContain(projectVectorCollectionName("proj-a"))
    // Remote payload carries the REDACTED text, never the original.
    expect(added).toHaveLength(1)
    expect(added[0].docs[0].content).toBe("original <EMAIL_001>")
    expect(added[0].docs[0].metadata).toMatchObject({ projectId: "proj-a", fileId: "file-1" })
    // Dexie keeps both.
    const rows = await listProjectChunksByFile("proj-a", "file-1")
    expect(rows).toHaveLength(1)
    expect(rows[0].content).toBe("original secret")
    expect(rows[0].contentRedacted).toBe("original <EMAIL_001>")
    expect(rows[0].contentHash).toBe("h1")
    expect(result.vectorDocIds[0]).toMatch(/^proj-a__file-1__pgen_.+__0$/)
    expect(rows[0].generationId).toBe(result.generationId)
  })

  it("idempotent replace: drops prior chunks + remote vectors before re-inserting", async () => {
    const { store, deleted } = fakeStore()
    await persistProjectChunks({
      projectId: "proj-a",
      fileId: "file-1",
      vectorBackend: "qdrant",
      store,
      contentHash: "h1",
      chunks: [chunk("v1")],
      embeddings: [[0.1]],
    })
    await persistProjectChunks({
      projectId: "proj-a",
      fileId: "file-1",
      vectorBackend: "qdrant",
      store,
      contentHash: "h2",
      chunks: [chunk("v2a"), chunk("v2b")],
      embeddings: [[0.2], [0.3]],
    })

    expect(deleted).toHaveLength(1)
    expect(deleted[0].ids[0]).toMatch(/^proj-a__file-1__pgen_.+__0$/)
    const rows = await listProjectChunksByFile("proj-a", "file-1")
    expect(rows).toHaveLength(2)
    expect(rows.every((r) => r.contentHash === "h2")).toBe(true)
    expect(await countProjectChunksByFile("proj-a", "file-1")).toBe(2)
  })

  it("tolerates a remote deleteDocuments failure on re-ingest", async () => {
    const { store } = fakeStore()
    ;(store.deleteDocuments as jest.Mock).mockRejectedValueOnce(new Error("remote down"))
    await persistProjectChunks({
      projectId: "proj-a",
      fileId: "file-1",
      vectorBackend: "qdrant",
      store,
      contentHash: "h1",
      chunks: [chunk("v1")],
      embeddings: [[0.1]],
    })
    // Second run: remote delete rejects, but the local rows are still replaced.
    const result = await persistProjectChunks({
      projectId: "proj-a",
      fileId: "file-1",
      vectorBackend: "qdrant",
      store,
      contentHash: "h2",
      chunks: [chunk("v2")],
      embeddings: [[0.2]],
    })
    expect(result.cleanupPending).toBe(true)
    const rows = await listProjectChunksByFile("proj-a", "file-1")
    expect(rows).toHaveLength(1)
    expect(rows[0].contentHash).toBe("h2")
  })

  it("keeps the active generation when the staging vector write fails", async () => {
    const { store } = fakeStore()
    const first = await persistProjectChunks({
      projectId: "proj-a",
      fileId: "file-1",
      vectorBackend: "qdrant",
      store,
      contentHash: "h1",
      chunks: [chunk("v1")],
      embeddings: [[0.1]],
    })
    ;(store.addDocuments as jest.Mock).mockRejectedValueOnce(new Error("remote down"))

    await expect(
      persistProjectChunks({
        projectId: "proj-a",
        fileId: "file-1",
        vectorBackend: "qdrant",
        store,
        contentHash: "h2",
        chunks: [chunk("v2")],
        embeddings: [[0.2]],
      })
    ).rejects.toThrow("remote down")
    const rows = await listProjectChunksByFile("proj-a", "file-1")
    expect(rows).toHaveLength(1)
    expect(rows[0].contentHash).toBe("h1")
    expect(rows[0].generationId).toBe(first.generationId)
  })
})
