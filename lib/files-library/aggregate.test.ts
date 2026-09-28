import type { LibraryItemRow } from "@/lib/db/files-library-types"
import {
  aggregateFilesEntries,
  entryRecency,
  isImageMediaType,
  originalMediaKey,
  STANDALONE_CANVAS_SESSION_ID,
  type FilesAggregateInput,
  type RawUpload,
} from "./aggregate"

function input(overrides: Partial<FilesAggregateInput> = {}): FilesAggregateInput {
  return {
    artifacts: [],
    canvases: [],
    images: [],
    sessionUploads: [],
    libraryUploads: [],
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
          },
          {
            id: "c2",
            sessionId: "s2",
            title: "Draft",
            content: "",
            type: "text",
            createdAt: 1,
            updatedAt: 1,
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
          },
          { hash: "h2", mediaType: "image/png", byteSize: 3, createdAt: 4, sessionIds: [] },
          { hash: "h3", mediaType: "image/png", byteSize: 3, createdAt: 4, sessionIds: [] },
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
})
