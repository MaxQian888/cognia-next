import type { LibraryItemRow } from "@/lib/db/files-library-types"
import {
  aggregateFilesEntries,
  entryRecency,
  isImageMediaType,
  isItemHidden,
  originalMediaKey,
  STANDALONE_CANVAS_SESSION_ID,
  type FilesAggregateInput,
  type RawUpload,
} from "./aggregate"
import { workspaceFileSourceId } from "./workspace-files"

function input(overrides: Partial<FilesAggregateInput> = {}): FilesAggregateInput {
  return {
    artifacts: [],
    canvases: [],
    images: [],
    sessionUploads: [],
    libraryUploads: [],
    generatedVideos: [],
    items: [],
    sessions: new Map([
      ["s1", { projectId: "p1" }],
      ["s2", { projectId: "p2" }],
    ]),
    heldOriginals: new Set(),
    ...overrides,
  }
}

function upload(overrides: Partial<RawUpload> = {}): RawUpload {
  return {
    sessionId: "s1",
    assetId: "a1",
    contentHash: "c1",
    filename: "SPEC.md",
    mediaType: "text/markdown",
    byteSize: 10,
    createdAt: 1,
    updatedAt: 2,
    extractedText: "Design Body",
    sourceAvailable: true,
    ...overrides,
  }
}

function item(
  overrides: Partial<LibraryItemRow> & Pick<LibraryItemRow, "key" | "kind" | "sourceId">
): LibraryItemRow {
  return { createdAt: 1, updatedAt: 1, ...overrides }
}

describe("aggregateFilesEntries", () => {
  it("maps artifacts with workspace, liveness and search text", () => {
    const [entry] = aggregateFilesEntries(
      input({
        artifacts: [
          {
            id: "a",
            sessionId: "gone",
            projectId: "p9",
            type: "code",
            title: "Parser",
            content: "export const X = 1",
            language: "typescript",
            createdAt: 1,
            updatedAt: 5,
            lastAccessedAt: 9,
            creator: "ai",
          },
        ],
        items: [
          item({
            key: "artifact:a",
            kind: "artifact",
            sourceId: "a",
            favoritedAt: 3,
            lastOpenedAt: 12,
          }),
        ],
      })
    )
    expect(entry).toMatchObject({
      key: "artifact:a",
      kind: "artifact",
      projectIds: ["p9"],
      sessionIds: [],
      originSessionId: "gone",
      originAlive: false,
      favoritedAt: 3,
      lastAccessedAt: 12,
      hidden: false,
      byteSize: 18,
    })
    expect(entry!.searchText).toContain("export const x")
  })

  it("treats standalone canvas documents as alive without a conversation", () => {
    const [standalone, live] = aggregateFilesEntries(
      input({
        canvases: [
          {
            id: "c1",
            sessionId: STANDALONE_CANVAS_SESSION_ID,
            title: "Notes",
            content: "",
            type: "text",
            createdAt: 1,
            updatedAt: 1,
            creator: "user",
          },
          {
            id: "c2",
            sessionId: "s2",
            title: "Draft",
            content: "",
            type: "text",
            createdAt: 1,
            updatedAt: 1,
            creator: "user",
          },
        ],
      })
    )
    expect(standalone).toMatchObject({ originAlive: true, sessionIds: [], projectIds: [] })
    expect(standalone!.originSessionId).toBeUndefined()
    expect(live).toMatchObject({ originAlive: true, sessionIds: ["s2"], projectIds: ["p2"] })
  })

  it("shows images referenced by live conversations or kept by Files, and skips GC-bound ones", () => {
    const entries = aggregateFilesEntries(
      input({
        images: [
          {
            hash: "h1",
            mediaType: "image/png",
            byteSize: 3,
            createdAt: 4,
            sessionIds: ["s1", "s2", "dead"],
            creator: "user",
          },
          {
            hash: "h2",
            mediaType: "image/png",
            byteSize: 3,
            createdAt: 4,
            sessionIds: [],
            creator: "ai",
          },
          {
            hash: "h3",
            mediaType: "image/png",
            byteSize: 3,
            createdAt: 4,
            sessionIds: [],
            creator: "ai",
          },
        ],
        items: [
          item({
            key: "image:h2",
            kind: "image",
            sourceId: "h2",
            folderId: "root",
            snapshot: { title: "Mock" },
          }),
        ],
      })
    )
    expect(entries.map((entry) => entry.key)).toEqual(["image:h1", "image:h2"])
    expect(entries[0]).toMatchObject({
      sessionIds: ["s1", "s2"],
      projectIds: ["p1", "p2"],
      originAlive: true,
      mediaHash: "h1",
    })
    expect(entries[1]).toMatchObject({ originAlive: false, title: "Mock", folderId: "root" })
  })

  it("folds conversation uploads by content hash and drops image uploads", () => {
    const entries = aggregateFilesEntries(
      input({
        sessionUploads: [
          upload(),
          upload({ sessionId: "s2", assetId: "a2", filename: "SPEC(1).md", updatedAt: 9 }),
          upload({ assetId: "img", contentHash: "c2", mediaType: "image/png" }),
          upload({ assetId: "gone", contentHash: "c3", sourceAvailable: false }),
        ],
      })
    )
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({
      key: "session-upload:c1",
      title: "SPEC(1).md",
      sessionIds: ["s1", "s2"],
      assetId: "a2",
      assetSessionId: "s2",
      createdAt: 1,
      updatedAt: 9,
      mediaHash: originalMediaKey("c1"),
      excerpt: "Design Body",
    })
    expect(entries[0]!.searchText).toContain("design body")
  })

  it("folds a conversation upload into the Files-owned upload with the same bytes", () => {
    const entries = aggregateFilesEntries(
      input({
        libraryUploads: [upload({ sessionId: "library:files", assetId: "u1" })],
        sessionUploads: [upload()],
      })
    )
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({
      key: "upload:u1",
      ownedByFiles: true,
      sessionIds: ["s1"],
      originAlive: true,
    })
  })

  it("rebuilds a kept upload from its snapshot once its conversations are gone", () => {
    const kept = item({
      key: "session-upload:c9",
      kind: "session-upload",
      sourceId: "c9",
      favoritedAt: 2,
      keptAt: 2,
      snapshot: {
        title: "old.pdf",
        mediaType: "application/pdf",
        byteSize: 7,
        extractedText: "Quarterly",
      },
    })
    const unheld = item({
      key: "session-upload:c8",
      kind: "session-upload",
      sourceId: "c8",
      favoritedAt: 2,
    })
    const entries = aggregateFilesEntries(
      input({ items: [kept, unheld], heldOriginals: new Set([originalMediaKey("c9")]) })
    )
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({
      title: "old.pdf",
      originAlive: false,
      updatedAt: 2,
      excerpt: "Quarterly",
    })
  })

  it("hides a removed item until its source changes after the removal", () => {
    const artifact = {
      id: "a",
      sessionId: "s1",
      type: "code",
      title: "t",
      content: "",
      createdAt: 1,
      updatedAt: 5,
      creator: "ai" as const,
    }
    const hiddenNow = aggregateFilesEntries(
      input({
        artifacts: [artifact],
        items: [item({ key: "artifact:a", kind: "artifact", sourceId: "a", hiddenAt: 6 })],
      })
    )
    expect(hiddenNow[0]!.hidden).toBe(true)
    const changed = aggregateFilesEntries(
      input({
        artifacts: [{ ...artifact, updatedAt: 7 }],
        items: [item({ key: "artifact:a", kind: "artifact", sourceId: "a", hiddenAt: 6 })],
      })
    )
    expect(changed[0]!.hidden).toBe(false)
  })
})

describe("generated videos", () => {
  const generated = {
    jobId: "vjob_1",
    prompt: "A paper boat on a rainy street",
    providerId: "doubao",
    modelId: "seedance-1",
    durationSec: 5,
  }

  it("carries the job's record on the conversation upload it stored", () => {
    const entries = aggregateFilesEntries(
      input({
        sessionUploads: [
          upload({
            assetId: "video-vjob_1",
            contentHash: "v1",
            filename: "A paper boat on a rainy street.mp4",
            mediaType: "video/mp4",
            extractedText: undefined,
          }),
          upload(),
        ],
        generatedVideos: [
          {
            ...generated,
            home: { kind: "session-asset", sessionId: "s1", assetId: "video-vjob_1" },
          },
        ],
      })
    )
    const video = entries.find((entry) => entry.sourceId === "v1")!
    expect(video).toMatchObject({ kind: "session-upload", generated })
    expect(video.generated).not.toHaveProperty("home")
    expect(video.searchText).toContain("seedance-1")
    expect(entries.find((entry) => entry.sourceId === "c1")!.generated).toBeUndefined()
  })

  it("keeps the record when a chat video was also saved into Files", () => {
    const entries = aggregateFilesEntries(
      input({
        sessionUploads: [
          upload({
            assetId: "video-vjob_1",
            contentHash: "v1",
            filename: "boat.mp4",
            mediaType: "video/mp4",
            extractedText: undefined,
          }),
        ],
        libraryUploads: [
          upload({
            assetId: "u9",
            contentHash: "v1",
            filename: "boat.mp4",
            mediaType: "video/mp4",
          }),
        ],
        generatedVideos: [
          {
            ...generated,
            home: { kind: "session-asset", sessionId: "s1", assetId: "video-vjob_1" },
          },
        ],
      })
    )
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ kind: "upload", sessionIds: ["s1"], generated })
    expect(entries[0]!.searchText).toContain("a paper boat on a rainy street")
  })

  it("carries it on a Files upload, and ignores a job whose upload is gone", () => {
    const entries = aggregateFilesEntries(
      input({
        libraryUploads: [
          upload({
            assetId: "video-vjob_1",
            contentHash: "v1",
            filename: "boat.mp4",
            mediaType: "video/mp4",
          }),
        ],
        generatedVideos: [
          { ...generated, home: { kind: "library", assetId: "video-vjob_1" } },
          { ...generated, jobId: "vjob_2", home: { kind: "library", assetId: "video-vjob_2" } },
        ],
      })
    )
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ kind: "upload", generated })
    expect(entries[0]!.searchText).toContain("a paper boat on a rainy street")
  })

  // The job row goes with its conversation; the item's snapshot keeps a copy.
  describe("once the job row is gone", () => {
    it("rebuilds a kept upload whose conversations are all gone with its record", () => {
      const [entry] = aggregateFilesEntries(
        input({
          items: [
            item({
              key: "session-upload:v1",
              kind: "session-upload",
              sourceId: "v1",
              favoritedAt: 3,
              snapshot: { title: "boat.mp4", mediaType: "video/mp4", generated },
            }),
          ],
          heldOriginals: new Set([originalMediaKey("v1")]),
        })
      )
      expect(entry).toMatchObject({ kind: "session-upload", originAlive: false, generated })
      expect(entry!.searchText).toContain("seedance-1")
    })

    it("keeps it on a Files upload and on a conversation upload still in another chat", () => {
      const entries = aggregateFilesEntries(
        input({
          libraryUploads: [
            upload({
              assetId: "u9",
              contentHash: "v1",
              filename: "boat.mp4",
              mediaType: "video/mp4",
            }),
          ],
          sessionUploads: [
            upload({ sessionId: "s2", assetId: "fwd", contentHash: "v2", mediaType: "video/mp4" }),
          ],
          items: [
            item({
              key: "upload:u9",
              kind: "upload",
              sourceId: "u9",
              ownedByFiles: true,
              snapshot: { title: "boat.mp4", generated },
            }),
            item({
              key: "session-upload:v2",
              kind: "session-upload",
              sourceId: "v2",
              favoritedAt: 1,
              snapshot: { title: "fwd.mp4", generated: { ...generated, jobId: "vjob_2" } },
            }),
          ],
        })
      )
      expect(entries.find((entry) => entry.sourceId === "u9")).toMatchObject({ generated })
      expect(entries.find((entry) => entry.sourceId === "v2")!.generated?.jobId).toBe("vjob_2")
    })

    it("prefers the live job's record while it lasts", () => {
      const [entry] = aggregateFilesEntries(
        input({
          libraryUploads: [
            upload({ assetId: "video-vjob_1", contentHash: "v1", mediaType: "video/mp4" }),
          ],
          generatedVideos: [{ ...generated, home: { kind: "library", assetId: "video-vjob_1" } }],
          items: [
            item({
              key: "upload:video-vjob_1",
              kind: "upload",
              sourceId: "video-vjob_1",
              snapshot: { title: "t", generated: { ...generated, prompt: "stale copy" } },
            }),
          ],
        })
      )
      expect(entry!.generated?.prompt).toBe(generated.prompt)
    })
  })
})

describe("helpers", () => {
  it("orders by the newer of opened and changed", () => {
    expect(entryRecency({ updatedAt: 5 })).toBe(5)
    expect(entryRecency({ updatedAt: 5, lastAccessedAt: 9 })).toBe(9)
  })

  it("recognizes image media types", () => {
    expect(isImageMediaType("IMAGE/PNG")).toBe(true)
    expect(isImageMediaType("text/plain")).toBe(false)
    expect(isImageMediaType(undefined)).toBe(false)
  })

  it("keeps a trashed item in the Trash only: never hidden, never revived", () => {
    const artifact = {
      id: "a",
      sessionId: "s1",
      type: "code",
      title: "t",
      content: "",
      createdAt: 1,
      updatedAt: 9,
      creator: "ai" as const,
    }
    const [entry] = aggregateFilesEntries(
      input({
        artifacts: [artifact],
        items: [
          item({ key: "artifact:a", kind: "artifact", sourceId: "a", hiddenAt: 6, trashedAt: 7 }),
        ],
      })
    )
    expect(entry).toMatchObject({ trashedAt: 7, hidden: false })
  })

  it("shows a display name, keeps the source's title, and finds the item by either", () => {
    const [entry] = aggregateFilesEntries(
      input({
        artifacts: [
          {
            id: "a",
            sessionId: "s1",
            type: "code",
            title: "Parser",
            content: "",
            createdAt: 1,
            updatedAt: 1,
            creator: "ai",
          },
        ],
        items: [
          item({ key: "artifact:a", kind: "artifact", sourceId: "a", displayName: " Lexer " }),
        ],
      })
    )
    expect(entry).toMatchObject({ title: "Lexer", sourceTitle: "Parser" })
    expect(entry!.searchText).toContain("lexer")
    expect(entry!.searchText).toContain("parser")
  })

  it("counts the live share links made from Files that carry an item", () => {
    const canvas = (id: string) => ({
      id,
      sessionId: "s1",
      title: id,
      content: "",
      type: "text" as const,
      createdAt: 1,
      updatedAt: 1,
      creator: "user" as const,
    })
    const entries = aggregateFilesEntries(
      input({
        canvases: [canvas("a"), canvas("b"), canvas("c")],
        items: [
          item({ key: "canvas:a", kind: "canvas", sourceId: "a", sharedLinkCodes: ["x", "y"] }),
          item({ key: "canvas:b", kind: "canvas", sourceId: "b", sharedLinkCodes: ["dead"] }),
        ],
        liveShareCodes: new Set(["x", "y"]),
      })
    )
    const byKey = new Map(entries.map((entry) => [entry.key, entry]))
    expect(byKey.get("canvas:a")!.sharedLinks).toBe(2)
    expect(byKey.get("canvas:b")!.sharedLinks).toBeUndefined()
    expect(byKey.get("canvas:c")!.sharedLinks).toBeUndefined()

    // Without any live link nothing is marked.
    const [none] = aggregateFilesEntries(
      input({
        canvases: [canvas("a")],
        items: [item({ key: "canvas:a", kind: "canvas", sourceId: "a", sharedLinkCodes: ["x"] })],
      })
    )
    expect(none!.sharedLinks).toBeUndefined()
  })

  it("carries who made each item, the origin conversation's title and whether it was shared with me", () => {
    const entries = aggregateFilesEntries(
      input({
        sessions: new Map([
          ["s1", { projectId: "p1", title: "Planning" }],
          ["shared:x", { title: "Their chat", sharedWithMe: true }],
        ]),
        artifacts: [
          {
            id: "a",
            sessionId: "shared:x",
            type: "code",
            title: "From them",
            content: "",
            createdAt: 1,
            updatedAt: 1,
            creator: "ai",
          },
        ],
        canvases: [
          {
            id: "c",
            sessionId: "s1",
            title: "Mine",
            content: "",
            type: "text",
            createdAt: 1,
            updatedAt: 1,
            creator: "user",
          },
        ],
        sessionUploads: [upload({ sessionId: "s1" })],
      })
    )
    const byKey = new Map(entries.map((entry) => [entry.key, entry]))
    expect(byKey.get("artifact:a")).toMatchObject({
      creator: "ai",
      sharedWithMe: true,
      originSessionTitle: "Their chat",
    })
    expect(byKey.get("canvas:c")).toMatchObject({
      creator: "user",
      sharedWithMe: false,
      originSessionTitle: "Planning",
    })
    expect(byKey.get("session-upload:c1")).toMatchObject({ creator: "user" })
  })
})

describe("isItemHidden", () => {
  it("hides until the source changes, and never hides a trashed item", () => {
    expect(isItemHidden(undefined, 5)).toBe(false)
    expect(isItemHidden({ hiddenAt: 6 }, 5)).toBe(true)
    expect(isItemHidden({ hiddenAt: 6 }, 7)).toBe(false)
    expect(isItemHidden({ hiddenAt: 6, trashedAt: 6 }, 5)).toBe(false)
  })
})

describe("workspace files (ADR-0223 §8)", () => {
  const file = {
    sessionId: "s1",
    workspaceRoot: "/repo",
    executionRoot: "/exec/run-1",
    relPath: "docs/plan.md",
    change: "created" as const,
    mediaType: "text/markdown",
    byteSize: 12,
    createdAt: 10,
    updatedAt: 20,
  }
  const sourceId = workspaceFileSourceId("s1", "/repo", "docs/plan.md")

  it("is one AI-made card per conversation and path, found by its name and path", () => {
    const entries = aggregateFilesEntries(input({ workspaceFiles: [file, { ...file }] }))
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({
      key: `workspace-file:${sourceId}`,
      kind: "workspace-file",
      sourceId,
      title: "plan.md",
      mediaType: "text/markdown",
      byteSize: 12,
      projectIds: ["p1"],
      sessionIds: ["s1"],
      originSessionId: "s1",
      originAlive: true,
      creator: "ai",
      createdAt: 10,
      updatedAt: 20,
      workspace: {
        sessionId: "s1",
        workspaceRoot: "/repo",
        executionRoot: "/exec/run-1",
        relPath: "docs/plan.md",
        change: "created",
      },
    })
    expect(entries[0]!.searchText).toContain("docs/plan.md")
    // Its conversation gone, the card stays; it can no longer open there.
    const [orphan] = aggregateFilesEntries(
      input({ workspaceFiles: [{ ...file, sessionId: "gone" }] })
    )
    expect(orphan).toMatchObject({ originAlive: false, sessionIds: [] })
  })

  it("folds the Files metadata in, and rebuilds a kept one the ledger no longer lists", () => {
    const kept = item({
      key: `workspace-file:${sourceId}`,
      kind: "workspace-file",
      sourceId,
      favoritedAt: 5,
      displayName: "The plan",
      keptAt: 7,
      snapshot: {
        title: "plan.md",
        mediaType: "text/markdown",
        byteSize: 12,
        workspace: {
          sessionId: "s1",
          workspaceRoot: "/repo",
          executionRoot: "/exec/run-1",
          relPath: "docs/plan.md",
        },
      },
    })
    const [listed] = aggregateFilesEntries(input({ workspaceFiles: [file], items: [kept] }))
    expect(listed).toMatchObject({ title: "The plan", sourceTitle: "plan.md", favoritedAt: 5 })

    const [rebuilt] = aggregateFilesEntries(input({ workspaceFiles: [], items: [kept] }))
    expect(rebuilt).toMatchObject({
      key: `workspace-file:${sourceId}`,
      title: "The plan",
      originAlive: true,
      updatedAt: 7,
      workspace: { relPath: "docs/plan.md" },
    })
    // What the agent did last is not known any more.
    expect(rebuilt!.workspace).not.toHaveProperty("change")
    // Not kept: nothing to rebuild.
    expect(
      aggregateFilesEntries(
        input({ workspaceFiles: [], items: [{ ...kept, favoritedAt: undefined }] })
      )
    ).toEqual([])
  })

  it("lists none where there are no workspace files, kept ones included", () => {
    const kept = item({
      key: `workspace-file:${sourceId}`,
      kind: "workspace-file",
      sourceId,
      folderId: "root",
      snapshot: { title: "plan.md", workspace: { ...file } },
    })
    expect(aggregateFilesEntries(input({ items: [kept] }))).toEqual([])
  })
})
