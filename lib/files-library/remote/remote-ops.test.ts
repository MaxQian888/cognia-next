/** @jest-environment jsdom */
const mockAddContextSelection = jest.fn()
let mockActiveSessionId: string | null = "s-phone"
jest.mock("@/stores/chat", () => ({
  useChatStore: {
    getState: () => ({
      activeSessionId: mockActiveSessionId,
      addContextSelection: mockAddContextSelection,
    }),
  },
}))

import type { FilesEntry } from "../types"
import type { FilesRemoteClient } from "./client"
import { FilesRemoteError } from "./client"
import {
  createRemoteFilesOps,
  FILES_PAIRED_HELD_BACK,
  PAIRED_FILES_CAPABILITIES,
} from "./remote-ops"
import { FILES_REMOTE_MAX_BYTES } from "./types"

function entry(overrides: Partial<FilesEntry> = {}): FilesEntry {
  return {
    key: "artifact:a1",
    kind: "artifact",
    sourceId: "a1",
    title: "Plan",
    sourceTitle: "Plan",
    subtype: "document",
    projectIds: [],
    sessionIds: [],
    originSessionId: "s1",
    originAlive: true,
    createdAt: 1,
    updatedAt: 2,
    ownedByFiles: false,
    hidden: false,
    sharedWithMe: false,
    creator: "ai",
    searchText: "plan",
    ...overrides,
  }
}

function client(over: Partial<FilesRemoteClient> = {}): jest.Mocked<FilesRemoteClient> {
  const ok = jest.fn(async () => undefined)
  return {
    list: jest.fn(),
    folders: jest.fn(),
    search: jest.fn(),
    get: jest.fn(async () => ({ entry: entry(), text: "# Plan" })),
    favorite: ok,
    move: ok,
    trash: ok,
    restore: ok,
    purge: jest.fn(async () => ({ retired: 2 })),
    touch: ok,
    rename: ok,
    duplicate: jest.fn(async () => ({ kind: "canvas" as const, key: "canvas:c2" })),
    attach: jest.fn(async () => ({ sessionId: "s-phone", created: false, how: "bound" as const })),
    createFolder: jest.fn(async () => "lbf_new"),
    renameFolder: ok,
    moveFolder: ok,
    setFolderStyle: ok,
    deleteFolder: ok,
    upload: jest.fn(async () => "upload:new"),
    readMedia: jest.fn(async () => ({ bytes: new Uint8Array([1, 2]), mediaType: "image/png" })),
    readWorkspaceFile: jest.fn(async () => new Uint8Array()),
    ...over,
  } as unknown as jest.Mocked<FilesRemoteClient>
}

beforeEach(() => {
  mockAddContextSelection.mockClear()
  mockActiveSessionId = "s-phone"
})

describe("paired capabilities", () => {
  it("hold back document creation and sharing, each with where to do it (dormancy, rule 7)", () => {
    expect(PAIRED_FILES_CAPABILITIES).toEqual({
      createDocuments: { reason: "canvas-not-editable-here", remedy: "desktop" },
      share: { reason: "host-owns-share-records", remedy: "desktop" },
      open: "preview",
      maxTransferBytes: FILES_REMOTE_MAX_BYTES,
      // The host lists its own workspace files and reads them for the device.
      workspaceFiles: true,
    })
    expect(FILES_PAIRED_HELD_BACK.share.remedy).toBe("desktop")
  })
})

describe("remote ops", () => {
  it("send each change with the device's image window, then re-read the host", async () => {
    const c = client()
    const onChanged = jest.fn()
    const ops = createRemoteFilesOps({ client: c, imageLimit: () => 120, onChanged })
    await ops.trash([entry(), entry({ key: "upload:u1" })])
    expect(c.trash).toHaveBeenCalledWith(["artifact:a1", "upload:u1"], 120)
    await ops.moveToFolder([entry()], null)
    expect(c.move).toHaveBeenCalledWith(["artifact:a1"], null, 120)
    expect(await ops.purge([entry()])).toEqual({ retired: 2 })
    await ops.deleteFolder("lbf_1", "cascade")
    expect(c.deleteFolder).toHaveBeenCalledWith("lbf_1", true)
    expect(onChanged).toHaveBeenCalledTimes(4)
  })

  it("re-reads even when the host refused", async () => {
    const onChanged = jest.fn()
    const ops = createRemoteFilesOps({
      client: client({ rename: jest.fn(async () => Promise.reject(new FilesRemoteError("x"))) }),
      imageLimit: () => 60,
      onChanged,
    })
    await expect(ops.rename(entry(), "New")).rejects.toMatchObject({ code: "x" })
    expect(onChanged).toHaveBeenCalledTimes(1)
  })

  it("does not re-read for a touch, which changes no listing the device sorts by now", async () => {
    const onChanged = jest.fn()
    const c = client()
    await createRemoteFilesOps({ client: c, imageLimit: () => 60, onChanged }).touch(entry())
    expect(c.touch).toHaveBeenCalledWith("artifact:a1", 60)
    expect(onChanged).not.toHaveBeenCalled()
  })

  it("hands a document's text, and a file's original bytes, to Download", async () => {
    const c = client()
    const ops = createRemoteFilesOps({ client: c, imageLimit: () => 60, onChanged: jest.fn() })
    const doc = await ops.payloadFor(entry())
    expect(doc!.blob.size).toBe("# Plan".length)
    expect(doc!.filename).toMatch(/\.md$|\.txt$/)
    const image = await ops.payloadFor(entry({ kind: "image", key: "image:x", sourceId: "x" }))
    expect(image!.blob.type).toBe("image/png")
    expect(c.readMedia).toHaveBeenCalledWith(
      expect.objectContaining({ key: "image:x" }),
      "original"
    )

    const gone = createRemoteFilesOps({
      client: client({
        readMedia: jest.fn(async () =>
          Promise.reject(new FilesRemoteError("files_source_missing"))
        ),
      }),
      imageLimit: () => 60,
      onChanged: jest.fn(),
    })
    await expect(gone.payloadFor(entry({ kind: "upload", key: "upload:u" }))).resolves.toBeNull()
  })

  it("reads a workspace file off the host's disk, and is gone when the disk lost it", async () => {
    const c = client({
      readWorkspaceFile: jest.fn(async () => new Uint8Array([104, 105])),
    })
    const ops = createRemoteFilesOps({ client: c, imageLimit: () => 60, onChanged: jest.fn() })
    const file = entry({
      kind: "workspace-file",
      key: "workspace-file:w",
      title: "notes.md",
      mediaType: "text/markdown",
    })
    const payload = await ops.payloadFor(file)
    expect(c.readWorkspaceFile).toHaveBeenCalledWith(file, 60)
    expect(c.readMedia).not.toHaveBeenCalled()
    expect(payload).toMatchObject({ filename: "notes.md" })
    expect(payload!.blob.type).toBe("text/markdown")
    const gone = createRemoteFilesOps({
      client: client({
        readWorkspaceFile: jest.fn(async () =>
          Promise.reject(new FilesRemoteError("files_workspace_missing"))
        ),
      }),
      imageLimit: () => 60,
      onChanged: jest.fn(),
    })
    await expect(gone.payloadFor(file)).resolves.toBeNull()
  })

  it("builds a read-only artifact for the preview from the host's text", async () => {
    const ops = createRemoteFilesOps({
      client: client(),
      imageLimit: () => 60,
      onChanged: jest.fn(),
    })
    expect(await ops.artifactFor(entry())).toMatchObject({
      id: "a1",
      sessionId: "s1",
      type: "document",
      content: "# Plan",
    })
    expect(await ops.artifactFor(entry({ kind: "upload" }))).toBeNull()
  })

  it("binds a file on the host, in the device's open conversation", async () => {
    const c = client()
    const ops = createRemoteFilesOps({ client: c, imageLimit: () => 60, onChanged: jest.fn() })
    const outcome = await ops.useInChat(entry({ kind: "upload", key: "upload:u1" }), "Chat")
    expect(outcome).toEqual({ sessionId: "s-phone", how: "bound" })
    expect(c.attach).toHaveBeenCalledWith("upload:u1", {
      title: "Chat",
      imageLimit: 60,
      sessionId: "s-phone",
    })
    expect(mockAddContextSelection).not.toHaveBeenCalled()
  })

  it("stages a document as a chip in the device's own composer", async () => {
    mockActiveSessionId = null
    const c = client({
      attach: jest.fn(async () => ({
        sessionId: "s-new",
        created: true,
        how: "referenced" as const,
      })),
    })
    const ops = createRemoteFilesOps({ client: c, imageLimit: () => 60, onChanged: jest.fn() })
    expect(await ops.useInChat(entry(), "Chat")).toEqual({ sessionId: "s-new", how: "referenced" })
    expect(c.attach.mock.calls[0]![1]).not.toHaveProperty("sessionId")
    const [selection, sessionId] = mockAddContextSelection.mock.calls[0]!
    expect(sessionId).toBe("s-new")
    expect(selection).toMatchObject({ kind: "entity", entityKind: "artifact", entityId: "a1" })
  })

  it("refuses to stage a document with nothing in it", async () => {
    const c = client({
      attach: jest.fn(async () => ({ sessionId: "s", created: false, how: "referenced" as const })),
      get: jest.fn(async () => ({ entry: entry(), text: "  " })),
    })
    const ops = createRemoteFilesOps({ client: c, imageLimit: () => 60, onChanged: jest.fn() })
    await expect(ops.useInChat(entry(), "Chat")).rejects.toMatchObject({
      code: "files_source_empty",
    })
  })
})
