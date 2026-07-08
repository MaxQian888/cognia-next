/** @jest-environment jsdom */
import "fake-indexeddb/auto"
import type { ProjectChunk } from "@/types/project-knowledge"
import { __resetDbForTesting, getDb, whenSeeded } from "./schema"
import {
  bulkCreateProjectChunks,
  countProjectChunksByFile,
  countProjectChunksByProject,
  createProjectChunk,
  deleteProjectChunk,
  deleteProjectChunksByFile,
  deleteProjectChunksByProject,
  getIndexedContentHash,
  getProjectChunk,
  getProjectChunksByVectorDocIds,
  getProjectChunksVersion,
  listProjectChunksByFile,
  listProjectChunksByProject,
  type ProjectChunkDraft,
} from "./project-chunks"

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  getDb()
  await whenSeeded()
}, 30000)

function draft(overrides: Partial<ProjectChunkDraft> = {}): ProjectChunkDraft {
  return {
    projectId: "proj-a",
    fileId: "file-1",
    content: "hello world",
    contentRedacted: "hello world",
    charStart: 0,
    charEnd: 11,
    vectorBackend: "native",
    vectorCollection: "cognia_project_proj-a",
    vectorDocId: "proj-a__file-1__0",
    strategy: "paragraph",
    tokenCount: 3,
    metadata: {},
    contentHash: "hash-1",
    ...overrides,
  }
}

describe("project-chunks CRUD", () => {
  it("createProjectChunk stamps id + createdAt", async () => {
    const before = Date.now()
    const row = await createProjectChunk(draft())
    expect(row.id).toMatch(/^pkc_/)
    expect(row.createdAt).toBeGreaterThanOrEqual(before)
    const fetched = await getProjectChunk(row.id)
    expect(fetched?.content).toBe("hello world")
  })

  it("bulkCreateProjectChunks returns [] for empty and persists rows", async () => {
    expect(await bulkCreateProjectChunks([])).toEqual([])
    const rows = await bulkCreateProjectChunks([
      draft({ vectorDocId: "proj-a__file-1__0" }),
      draft({ vectorDocId: "proj-a__file-1__1", content: "second" }),
    ])
    expect(rows).toHaveLength(2)
    expect(await countProjectChunksByProject("proj-a")).toBe(2)
  })

  it("getProjectChunksByVectorDocIds resolves hits (and [] for empty input)", async () => {
    await bulkCreateProjectChunks([draft({ vectorDocId: "v0" }), draft({ vectorDocId: "v1" })])
    expect(await getProjectChunksByVectorDocIds([])).toEqual([])
    const hits = await getProjectChunksByVectorDocIds(["v1", "missing"])
    expect(hits).toHaveLength(1)
    expect(hits[0].vectorDocId).toBe("v1")
  })

  it("scopes reads by project — chunks of A never returned for B", async () => {
    await createProjectChunk(draft({ projectId: "proj-a", vectorDocId: "a0" }))
    await createProjectChunk(draft({ projectId: "proj-b", vectorDocId: "b0" }))
    const a = await listProjectChunksByProject("proj-a")
    const b = await listProjectChunksByProject("proj-b")
    expect(a).toHaveLength(1)
    expect(b).toHaveLength(1)
    expect(a[0].projectId).toBe("proj-a")
  })

  it("listProjectChunksByFile + countProjectChunksByFile filter by [projectId+fileId]", async () => {
    await bulkCreateProjectChunks([
      draft({ fileId: "file-1", vectorDocId: "f1a" }),
      draft({ fileId: "file-1", vectorDocId: "f1b" }),
      draft({ fileId: "file-2", vectorDocId: "f2a" }),
    ])
    expect(await countProjectChunksByFile("proj-a", "file-1")).toBe(2)
    const rows = await listProjectChunksByFile("proj-a", "file-2")
    expect(rows).toHaveLength(1)
    expect(rows[0].fileId).toBe("file-2")
  })

  it("getIndexedContentHash returns the file's hash or undefined", async () => {
    expect(await getIndexedContentHash("proj-a", "file-1")).toBeUndefined()
    await createProjectChunk(draft({ fileId: "file-1", contentHash: "h-current" }))
    expect(await getIndexedContentHash("proj-a", "file-1")).toBe("h-current")
  })

  it("getProjectChunksVersion returns count + newest createdAt", async () => {
    expect(await getProjectChunksVersion("proj-a")).toEqual({ count: 0, latestCreatedAt: 0 })
    await createProjectChunk(
      draft({ vectorDocId: "v0", createdAt: 1000 } as Partial<ProjectChunkDraft>)
    )
    await createProjectChunk(
      draft({ vectorDocId: "v1", createdAt: 5000 } as Partial<ProjectChunkDraft>)
    )
    const version = await getProjectChunksVersion("proj-a")
    expect(version.count).toBe(2)
    expect(version.latestCreatedAt).toBe(5000)
  })

  it("deleteProjectChunk removes a single row", async () => {
    const row = await createProjectChunk(draft())
    await deleteProjectChunk(row.id)
    expect(await getProjectChunk(row.id)).toBeUndefined()
  })

  it("deleteProjectChunksByFile drops only that file's chunks", async () => {
    await bulkCreateProjectChunks([
      draft({ fileId: "file-1", vectorDocId: "f1a" }),
      draft({ fileId: "file-2", vectorDocId: "f2a" }),
    ])
    const deleted = await deleteProjectChunksByFile("proj-a", "file-1")
    expect(deleted).toBe(1)
    expect(await countProjectChunksByProject("proj-a")).toBe(1)
  })

  it("deleteProjectChunksByProject drops the whole project", async () => {
    await bulkCreateProjectChunks([
      draft({ projectId: "proj-a", vectorDocId: "a0" }),
      draft({ projectId: "proj-a", vectorDocId: "a1" }),
      draft({ projectId: "proj-b", vectorDocId: "b0" }),
    ])
    const deleted = await deleteProjectChunksByProject("proj-a")
    expect(deleted).toBe(2)
    expect(await countProjectChunksByProject("proj-a")).toBe(0)
    expect(await countProjectChunksByProject("proj-b")).toBe(1)
  })

  it("listProjectChunksByProject honours limit/offset", async () => {
    await bulkCreateProjectChunks(
      Array.from({ length: 5 }, (_, i) => draft({ vectorDocId: `v${i}` }))
    )
    const page = await listProjectChunksByProject("proj-a", { limit: 2, offset: 1 })
    expect(page).toHaveLength(2)
  })
})
