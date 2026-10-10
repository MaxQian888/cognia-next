import type { FilesEntry } from "../types"
import {
  base64ToBytes,
  bytesToBase64,
  decodePageToken,
  encodePageToken,
  entryFromRemote,
  entryToRemote,
  FILES_REMOTE_KEYS_MAX,
  FILES_REMOTE_MAX_BYTES,
  FILES_REMOTE_PAGE_SIZE_DEFAULT,
  FILES_REMOTE_READ_CHUNK_MAX,
  FilesRemoteRequestError,
  isFilesRemoteListPage,
  isRefused,
  parseAttachRequest,
  parseCallerDeviceId,
  parseDuplicateRequest,
  parseFavoriteRequest,
  parseFolderDeleteRequest,
  parseFolderStyleRequest,
  parseKeys,
  parseListRequest,
  parseMoveRequest,
  parsePageRequest,
  parseReadChunkRequest,
  parseRenameRequest,
  parseSearchRequest,
  parseUploadChunkRequest,
  parseUploadCommitRequest,
  parseUploadInitRequest,
  refused,
} from "./types"

function entry(overrides: Partial<FilesEntry> = {}): FilesEntry {
  return {
    key: "artifact:a1",
    kind: "artifact",
    sourceId: "a1",
    title: "Plan",
    sourceTitle: "Plan v1",
    projectIds: [],
    sessionIds: ["s1"],
    originAlive: true,
    createdAt: 1,
    updatedAt: 2,
    ownedByFiles: false,
    hidden: false,
    sharedWithMe: false,
    creator: "ai",
    searchText: "plan\nsecret body text",
    excerpt: "secret body text",
    ...overrides,
  }
}

const invalid = (run: () => unknown) => expect(run).toThrow(FilesRemoteRequestError)

describe("refusals", () => {
  it("are recognised by shape, and only with a code", () => {
    expect(isRefused(refused("headless_host"))).toBe(true)
    expect(isRefused({ ok: false })).toBe(false)
    expect(isRefused({ ok: true, code: "x" })).toBe(false)
    expect(isRefused(null)).toBe(false)
  })
})

describe("entries on the wire", () => {
  it("leave the haystack and the excerpt behind, without touching the aggregate's object", () => {
    const original = entry()
    const remote = entryToRemote(original)
    expect(remote).not.toHaveProperty("searchText")
    expect(remote).not.toHaveProperty("excerpt")
    expect(original.excerpt).toBe("secret body text")
  })

  it("keep a workspace file's ledger run on the host, which reads its bytes by key", () => {
    const workspace = {
      sessionId: "s1",
      workspaceRoot: "/repo",
      executionRoot: "/exec/run-1",
      relPath: "plan.md",
      change: "created" as const,
      adoption: "pending" as const,
      runId: "run-1",
    }
    const original = entry({ kind: "workspace-file", workspace })
    const remote = entryToRemote(original)
    expect(remote.workspace).not.toHaveProperty("runId")
    expect(remote.workspace).toMatchObject({ adoption: "pending", relPath: "plan.md" })
    expect(original.workspace).toBe(workspace)
    expect(workspace.runId).toBe("run-1")
  })

  it("come back searchable by title, source title and type only", () => {
    const back = entryFromRemote(entryToRemote(entry({ mediaType: "text/markdown" })))
    expect(back.searchText).toBe("plan\nplan v1\ntext/markdown")
    expect(back.searchText).not.toContain("secret")
    // A workspace file is found by its path as well.
    const file = entryFromRemote(
      entryToRemote(
        entry({
          kind: "workspace-file",
          title: "plan.md",
          sourceTitle: "plan.md",
          workspace: {
            sessionId: "s1",
            workspaceRoot: "/repo",
            executionRoot: "/repo",
            relPath: "docs/plan.md",
          },
        })
      )
    )
    expect(file.searchText).toBe("plan.md\nplan.md\ndocs/plan.md")
  })

  it("are checked as a list page before use", () => {
    expect(
      isFilesRemoteListPage({
        ok: true,
        items: [entryToRemote(entry())],
        imagesTruncated: false,
        revision: "r",
      })
    ).toBe(true)
    expect(
      isFilesRemoteListPage({ ok: true, items: [{}], imagesTruncated: false, revision: "r" })
    ).toBe(false)
    expect(isFilesRemoteListPage({ ok: true, items: [], imagesTruncated: false })).toBe(false)
    expect(isFilesRemoteListPage({ ok: false, code: "x" })).toBe(false)
  })
})

describe("chunk bytes", () => {
  it("go to base64 and back, and refuse what is not base64", () => {
    const bytes = new Uint8Array([0, 1, 254, 255])
    expect(base64ToBytes(bytesToBase64(bytes))).toEqual(bytes)
    expect(base64ToBytes("@@")).toBeNull()
  })
})

describe("request parsing", () => {
  it("requires the caller the host stamped", () => {
    expect(parseCallerDeviceId({ callerDeviceId: "dev" })).toBe("dev")
    invalid(() => parseCallerDeviceId({}))
  })

  it("bounds and dedupes a selection", () => {
    expect(parseKeys({ keys: ["a", "b", "a"] })).toEqual(["a", "b"])
    invalid(() => parseKeys({ keys: [] }))
    invalid(() => parseKeys({ keys: [""] }))
    invalid(() =>
      parseKeys({ keys: Array.from({ length: FILES_REMOTE_KEYS_MAX + 1 }, (_, i) => `k${i}`) })
    )
    invalid(() => parseKeys({ keys: "a" }))
  })

  it("pages with tokens it issued itself", () => {
    expect(parsePageRequest({})).toEqual({ pageSize: FILES_REMOTE_PAGE_SIZE_DEFAULT, offset: 0 })
    expect(
      parseListRequest({ pageSize: 10, pageToken: encodePageToken(40), imageLimit: 7 }, 60)
    ).toEqual({
      imageLimit: 7,
      pageSize: 10,
      offset: 40,
    })
    expect(parseListRequest({}, 60).imageLimit).toBe(60)
    expect(decodePageToken("o12")).toBe(12)
    invalid(() => decodePageToken("12"))
    invalid(() => parseListRequest({ pageSize: 0 }, 60))
    invalid(() => parseListRequest({ pageSize: 501 }, 60))
    invalid(() => parseListRequest({ imageLimit: 1.5 }, 60))
  })

  it("refuses a blank search and caps its hits", () => {
    expect(parseSearchRequest({ query: "plan" })).toEqual({ query: "plan", limit: 50 })
    invalid(() => parseSearchRequest({ query: "   " }))
    invalid(() => parseSearchRequest({ query: "x", limit: 201 }))
  })

  it("reads favorite and move, where a null folder unfiles", () => {
    expect(parseFavoriteRequest({ keys: ["a"], favorite: false })).toEqual({
      keys: ["a"],
      favorite: false,
    })
    invalid(() => parseFavoriteRequest({ keys: ["a"], favorite: "yes" }))
    expect(parseMoveRequest({ keys: ["a"], folderId: null })).toEqual({
      keys: ["a"],
      folderId: null,
    })
    expect(parseMoveRequest({ keys: ["a"], folderId: "lbf_1" }).folderId).toBe("lbf_1")
    invalid(() => parseMoveRequest({ keys: ["a"] }))
  })

  it("refuses blank names", () => {
    expect(parseRenameRequest({ key: "a", name: "New" })).toEqual({ key: "a", name: "New" })
    invalid(() => parseRenameRequest({ key: "a", name: "  " }))
    invalid(() => parseRenameRequest({ key: "a", name: "x".repeat(256) }))
  })

  it("takes the device's copy suffix and an optional workspace for a duplicate", () => {
    expect(parseDuplicateRequest({ key: "a", suffix: " (copy)", fallbackName: "Image" })).toEqual({
      key: "a",
      suffix: " (copy)",
      fallbackName: "Image",
    })
    expect(
      parseDuplicateRequest({ key: "a", suffix: "副本", fallbackName: "x", projectId: "p" })
        .projectId
    ).toBe("p")
  })

  it("takes an optional conversation and a title for Use in chat", () => {
    expect(parseAttachRequest({ key: "a", title: "Chat" })).toEqual({ key: "a", title: "Chat" })
    expect(parseAttachRequest({ key: "a", title: "Chat", sessionId: "s1" }).sessionId).toBe("s1")
    invalid(() => parseAttachRequest({ key: "a" }))
  })

  it("validates folder styles against the folder palette, null clearing", () => {
    expect(parseFolderStyleRequest({ folderId: "f", color: "blue" })).toEqual({
      folderId: "f",
      style: { color: "blue" },
    })
    expect(parseFolderStyleRequest({ folderId: "f", color: null, icon: "star" }).style).toEqual({
      color: null,
      icon: "star",
    })
    invalid(() => parseFolderStyleRequest({ folderId: "f", color: "chartreuse" }))
    invalid(() => parseFolderStyleRequest({ folderId: "f", icon: "rocket" }))
    invalid(() => parseFolderStyleRequest({ folderId: "f" }))
  })

  it("reads the folder delete mode from an explicit boolean", () => {
    expect(parseFolderDeleteRequest({ folderId: "f", cascade: true }).mode).toBe("cascade")
    expect(parseFolderDeleteRequest({ folderId: "f", cascade: false }).mode).toBe("reparent")
    invalid(() => parseFolderDeleteRequest({ folderId: "f" }))
  })

  it("bounds a workspace file's read slice", () => {
    expect(parseReadChunkRequest({ key: "workspace-file:w", offset: 0 })).toEqual({
      key: "workspace-file:w",
      offset: 0,
      length: FILES_REMOTE_READ_CHUNK_MAX,
    })
    expect(parseReadChunkRequest({ key: "k", offset: 8, length: 4 }).length).toBe(4)
    invalid(() => parseReadChunkRequest({ key: "k" }))
    invalid(() => parseReadChunkRequest({ key: "k", offset: -1 }))
    invalid(() =>
      parseReadChunkRequest({ key: "k", offset: 0, length: FILES_REMOTE_READ_CHUNK_MAX + 1 })
    )
  })

  it("bounds an upload at the paired ceiling and checks its hash", () => {
    const hash = "A".repeat(64)
    expect(
      parseUploadInitRequest({ name: "a.pdf", mediaType: "application/pdf", size: 3, hash })
    ).toEqual({
      name: "a.pdf",
      mediaType: "application/pdf",
      size: 3,
      hash: hash.toLowerCase(),
    })
    invalid(() =>
      parseUploadInitRequest({ name: "a", mediaType: "x", size: FILES_REMOTE_MAX_BYTES + 1, hash })
    )
    invalid(() => parseUploadInitRequest({ name: "a", mediaType: "x", size: 0, hash }))
    invalid(() => parseUploadInitRequest({ name: "a", mediaType: "x", size: 1, hash: "zz" }))
    expect(parseUploadChunkRequest({ uploadId: "u", offset: 0, dataBase64: "AA==" })).toEqual({
      uploadId: "u",
      offset: 0,
      dataBase64: "AA==",
    })
    invalid(() => parseUploadChunkRequest({ uploadId: "u", dataBase64: "AA==" }))
    invalid(() => parseUploadChunkRequest({ uploadId: "u", offset: 0, dataBase64: "" }))
    expect(parseUploadCommitRequest({ uploadId: "u", folderId: "f" })).toEqual({
      uploadId: "u",
      folderId: "f",
    })
  })
})
