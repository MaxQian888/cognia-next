jest.mock("./ingest/ingest-file", () => {
  const actual = jest.requireActual("./ingest/ingest-file")
  return {
    ...actual,
    ingestKnowledgeFile: jest.fn(async () => ({ chunkCount: 1, skipped: false })),
  }
})
jest.mock("./runtime/build-deps", () => ({ tryBuildProjectKnowledgeDeps: jest.fn() }))
jest.mock("@/lib/db/project-chunks", () => ({
  deleteProjectChunksByFile: jest.fn(async () => 1),
  listProjectChunksByFile: jest.fn(async () => []),
}))

import type { Project } from "@/types"
import {
  createProjectKnowledgeIngestController,
  diffKnowledgeBases,
  snapshotOf,
} from "./wire-ingest"
import { hashContent, ingestKnowledgeFile } from "./ingest/ingest-file"
import { tryBuildProjectKnowledgeDeps } from "./runtime/build-deps"
import { deleteProjectChunksByFile, listProjectChunksByFile } from "@/lib/db/project-chunks"

const ingestMock = ingestKnowledgeFile as jest.Mock
const depsMock = tryBuildProjectKnowledgeDeps as jest.Mock
const deleteByFileMock = deleteProjectChunksByFile as jest.Mock
const listByFileMock = listProjectChunksByFile as jest.Mock

function kfile(id: string, content: string) {
  return {
    id,
    name: `${id}.md`,
    type: "text",
    content,
    size: content.length,
    createdAt: new Date(),
    updatedAt: new Date(),
  }
}
function project(id: string, files: Array<{ id: string; content: string }>): Project {
  return {
    id,
    name: id,
    roots: [],
    knowledgeBase: files.map((f) => kfile(f.id, f.content)),
    sessionIds: [],
    sessionCount: 0,
    messageCount: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
    lastAccessedAt: new Date(),
  } as unknown as Project
}

const okDeps = {
  store: { deleteDocuments: jest.fn(async () => undefined) },
  embedding: {},
  vectorBackend: "native",
}

beforeEach(() => {
  ingestMock.mockClear().mockResolvedValue({ chunkCount: 1, skipped: false })
  depsMock.mockReset().mockResolvedValue(okDeps)
  deleteByFileMock.mockClear().mockResolvedValue(1)
  listByFileMock.mockReset().mockResolvedValue([])
  okDeps.store.deleteDocuments.mockClear()
})

describe("diffKnowledgeBases (pure)", () => {
  it("snapshots each project's files by content hash", () => {
    const snap = snapshotOf([project("p", [{ id: "f1", content: "a" }])])
    expect(snap.get("p")?.get("f1")).toBe(hashContent("a"))
  })

  it("flags new + changed files to ingest and removed files to remove", () => {
    const prev = snapshotOf([
      project("p", [
        { id: "f1", content: "a" },
        { id: "f2", content: "b" },
      ]),
    ])
    const next = [
      project("p", [
        { id: "f1", content: "a-EDITED" },
        { id: "f3", content: "c" },
      ]),
    ]
    const diff = diffKnowledgeBases(prev, next)
    expect(diff.toIngest).toEqual(
      expect.arrayContaining([
        { projectId: "p", fileId: "f1" },
        { projectId: "p", fileId: "f3" },
      ])
    )
    expect(diff.toRemove).toEqual([{ projectId: "p", fileId: "f2" }])
  })

  it("does not emit changes for unchanged files", () => {
    const prev = snapshotOf([project("p", [{ id: "f1", content: "a" }])])
    const diff = diffKnowledgeBases(prev, [project("p", [{ id: "f1", content: "a" }])])
    expect(diff.toIngest).toEqual([])
    expect(diff.toRemove).toEqual([])
  })

  it("ignores a fully-removed project (cascade handles it)", () => {
    const prev = snapshotOf([project("p", [{ id: "f1", content: "a" }])])
    const diff = diffKnowledgeBases(prev, [])
    expect(diff.toRemove).toEqual([])
  })

  it("tolerates a project with an undefined knowledgeBase", () => {
    const p = { id: "p" } as unknown as Project
    const snap = snapshotOf([p])
    expect(snap.get("p")?.size).toBe(0)
    const diff = diffKnowledgeBases(new Map(), [p])
    expect(diff.toIngest).toEqual([])
    expect(diff.toRemove).toEqual([])
  })
})

describe("controller.reconcile", () => {
  it("ingests new files when a backend is configured", async () => {
    const controller = createProjectKnowledgeIngestController()
    await controller.reconcile([project("p", [{ id: "f1", content: "hello" }])])
    expect(ingestMock).toHaveBeenCalledTimes(1)
    expect(ingestMock.mock.calls[0][0].projectId).toBe("p")
  })

  it("is a no-op when no backend is configured", async () => {
    depsMock.mockResolvedValue(undefined)
    const controller = createProjectKnowledgeIngestController()
    await controller.reconcile([project("p", [{ id: "f1", content: "hello" }])])
    expect(ingestMock).not.toHaveBeenCalled()
  })

  it("does not re-ingest unchanged files on a second reconcile", async () => {
    const controller = createProjectKnowledgeIngestController()
    const projects = [project("p", [{ id: "f1", content: "hello" }])]
    await controller.reconcile(projects)
    ingestMock.mockClear()
    await controller.reconcile(projects)
    expect(ingestMock).not.toHaveBeenCalled()
  })

  it("removes chunks (local + remote) for a deleted file", async () => {
    listByFileMock.mockResolvedValue([{ vectorDocId: "p__f1__0" }])
    const controller = createProjectKnowledgeIngestController()
    await controller.reconcile([project("p", [{ id: "f1", content: "a" }])])
    await controller.reconcile([project("p", [])])
    expect(deleteByFileMock).toHaveBeenCalledWith("p", "f1")
    expect(okDeps.store.deleteDocuments).toHaveBeenCalledWith("cognia_project_p", ["p__f1__0"])
  })

  it("still drops local rows when the remote purge throws", async () => {
    listByFileMock.mockResolvedValue([{ vectorDocId: "p__f1__0" }])
    okDeps.store.deleteDocuments.mockRejectedValueOnce(new Error("remote down"))
    const controller = createProjectKnowledgeIngestController()
    await controller.reconcile([project("p", [{ id: "f1", content: "a" }])])
    await controller.reconcile([project("p", [])])
    expect(deleteByFileMock).toHaveBeenCalledWith("p", "f1")
  })
})

describe("controller manual reindex", () => {
  it("reindexFile forces ingest (skipUnchanged false)", async () => {
    const controller = createProjectKnowledgeIngestController()
    await controller.reindexFile("p", kfile("f1", "x") as never)
    expect(ingestMock).toHaveBeenCalledTimes(1)
    expect(ingestMock.mock.calls[0][0].skipUnchanged).toBe(false)
  })

  it("reindexProject on a project with no knowledgeBase is a no-op", async () => {
    const controller = createProjectKnowledgeIngestController()
    await controller.reindexProject({ id: "p" } as unknown as Project)
    expect(ingestMock).not.toHaveBeenCalled()
  })

  it("reindexProject ingests every file and updates the snapshot", async () => {
    const controller = createProjectKnowledgeIngestController()
    const p = project("p", [
      { id: "f1", content: "a" },
      { id: "f2", content: "b" },
    ])
    await controller.reindexProject(p)
    expect(ingestMock).toHaveBeenCalledTimes(2)
    // A follow-up reconcile with the same content is now a no-op.
    ingestMock.mockClear()
    await controller.reconcile([p])
    expect(ingestMock).not.toHaveBeenCalled()
  })
})
