/** @jest-environment jsdom */
jest.mock("@/lib/db/files-library-items", () => ({
  restoreLibraryItems: jest.fn(async () => 1),
  setLibraryItemsFavorite: jest.fn(async () => 1),
  setLibraryItemsFolder: jest.fn(async () => 1),
  touchLibraryItemOpened: jest.fn(async () => undefined),
  trashLibraryItems: jest.fn(async () => 1),
}))
jest.mock("@/lib/db/files-library-folders", () => ({
  createLibraryFolder: jest.fn(async () => ({ id: "lbf_new" })),
  deleteLibraryFolder: jest.fn(async () => undefined),
  moveLibraryFolder: jest.fn(async () => undefined),
  renameLibraryFolder: jest.fn(async () => undefined),
  setLibraryFolderStyle: jest.fn(async () => undefined),
}))
jest.mock("./trash", () => ({
  purgeTrashedItems: jest.fn(async () => ({ deleted: 1, retired: 2 })),
}))
jest.mock("./duplicate", () => ({ duplicateFilesEntry: jest.fn() }))
jest.mock("./upload", () => ({ uploadFileToLibrary: jest.fn(async () => ({ key: "upload:x" })) }))
jest.mock("./use-in-chat", () => ({
  attachEntryToSession: jest.fn(async () => "draft"),
  mentionCandidateFor: jest.fn((entry: { kind: string }) =>
    entry.kind === "artifact" ? {} : null
  ),
  resolveUseInChatTarget: jest.fn(async () => ({ session: { id: "s9" }, created: false })),
  stageEntryMention: jest.fn(async () => undefined),
}))

import { restoreLibraryItems, trashLibraryItems } from "@/lib/db/files-library-items"
import { createLibraryFolder, deleteLibraryFolder } from "@/lib/db/files-library-folders"
import { useArtifactStore } from "@/stores/artifact/artifact-store"
import { duplicateFilesEntry } from "./duplicate"
import { createLocalFilesOps, LOCAL_FILES_CAPABILITIES } from "./ops"
import { purgeTrashedItems } from "./trash"
import type { FilesEntry } from "./types"
import { attachEntryToSession, stageEntryMention } from "./use-in-chat"

function entry(overrides: Partial<FilesEntry> = {}): FilesEntry {
  return {
    key: "artifact:a",
    kind: "artifact",
    sourceId: "a",
    title: "A",
    sourceTitle: "A",
    projectIds: [],
    sessionIds: [],
    originAlive: false,
    createdAt: 1,
    updatedAt: 1,
    ownedByFiles: false,
    hidden: false,
    sharedWithMe: false,
    creator: "user",
    searchText: "",
    ...overrides,
  }
}

const ops = createLocalFilesOps()

describe("local Files ops", () => {
  it("can do everything here, and Open leaves Files", () => {
    expect(ops.mode).toBe("local")
    expect(ops.capabilities).toBe(LOCAL_FILES_CAPABILITIES)
    expect(LOCAL_FILES_CAPABILITIES).toEqual({
      createDocuments: true,
      share: true,
      open: "navigate",
    })
  })

  it("write through the library's own writers", async () => {
    await ops.trash([entry()])
    expect((trashLibraryItems as jest.Mock).mock.calls[0][0][0]).toMatchObject({
      kind: "artifact",
      sourceId: "a",
    })
    await ops.restore([entry()])
    expect((restoreLibraryItems as jest.Mock).mock.calls[0][0][0]).toMatchObject({
      originAlive: false,
    })
    expect(await ops.purge([entry({ ownedByFiles: true })])).toEqual({ retired: 2 })
    expect((purgeTrashedItems as jest.Mock).mock.calls[0][0][0]).toMatchObject({
      ownedByFiles: true,
    })
    await ops.createFolder("New", "root")
    expect(createLibraryFolder).toHaveBeenCalledWith({ name: "New", parentFolderId: "root" })
    await ops.deleteFolder("lbf_1", "reparent")
    expect(deleteLibraryFolder).toHaveBeenCalledWith("lbf_1", "reparent")
  })

  it("names a duplicate by its new item key", async () => {
    ;(duplicateFilesEntry as jest.Mock)
      .mockResolvedValueOnce({ kind: "canvas", id: "c2" })
      .mockResolvedValueOnce({ kind: "upload", key: "upload:u2" })
    const options = { suffix: " (copy)", fallbackName: "A" }
    expect(await ops.duplicate(entry(), options)).toEqual({ kind: "canvas", key: "canvas:c2" })
    expect(await ops.duplicate(entry(), options)).toEqual({ kind: "upload", key: "upload:u2" })
  })

  it("previews the artifact the store holds, or nothing", async () => {
    useArtifactStore.setState({ artifacts: { a: { id: "a" } } } as never)
    expect(await ops.artifactFor(entry())).toEqual({ id: "a" })
    expect(await ops.artifactFor(entry({ kind: "upload" }))).toBeNull()
    useArtifactStore.setState({ artifacts: {} } as never)
    expect(await ops.artifactFor(entry())).toBeNull()
  })

  it("references documents and attaches files in this device's composer", async () => {
    expect(await ops.useInChat(entry(), "About A")).toEqual({ sessionId: "s9", how: "referenced" })
    expect(stageEntryMention).toHaveBeenCalledWith(
      expect.objectContaining({ key: "artifact:a" }),
      "s9"
    )
    const file = entry({ key: "upload:u", kind: "upload" })
    expect(await ops.useInChat(file, "x")).toEqual({ sessionId: "s9", how: "attached" })
    ;(attachEntryToSession as jest.Mock).mockResolvedValueOnce("bound")
    expect(await ops.useInChat(file, "x")).toEqual({ sessionId: "s9", how: "bound" })
  })
})
