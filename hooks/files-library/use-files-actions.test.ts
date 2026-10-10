/**
 * @jest-environment jsdom
 */
import { act, renderHook } from "@testing-library/react"

const push = jest.fn()
jest.mock("next/navigation", () => ({ useRouter: () => ({ push }) }))
jest.mock("sonner", () => ({
  toast: { success: jest.fn(), error: jest.fn(), loading: jest.fn(() => "t1"), dismiss: jest.fn() },
}))
jest.mock("@/lib/db/files-library-items", () => {
  class LibraryItemError extends Error {
    constructor(readonly code: string) {
      super(code)
    }
  }
  return {
    LibraryItemError,
    restoreLibraryItems: jest.fn(async () => {}),
    setLibraryItemsFavorite: jest.fn(async () => {}),
    setLibraryItemsFolder: jest.fn(async () => {}),
    touchLibraryItemOpened: jest.fn(async () => {}),
    trashLibraryItems: jest.fn(async () => {}),
  }
})
jest.mock("@/lib/db/files-library-folders", () => {
  class LibraryFolderError extends Error {
    constructor(readonly code: string) {
      super(code)
    }
  }
  return {
    LibraryFolderError,
    moveLibraryFolder: jest.fn(async () => {}),
    setLibraryFolderStyle: jest.fn(async () => {}),
  }
})
jest.mock("@/lib/files/download", () => ({ downloadBlob: jest.fn() }))
jest.mock("@/lib/db/document-templates", () => {
  class DocumentTemplateError extends Error {
    constructor(readonly code: string) {
      super(code)
    }
  }
  return { DocumentTemplateError, deleteDocumentTemplate: jest.fn(async () => {}) }
})
jest.mock("@/lib/document-templates/service", () => ({
  ...jest.requireActual("@/lib/document-templates/service"),
  saveDocumentAsTemplate: jest.fn(async () => ({ id: "dtpl_again" })),
}))
jest.mock("@/lib/files-library/download", () => ({ downloadPayloadFor: jest.fn() }))
jest.mock("@/lib/files-library/duplicate", () => {
  class FilesDuplicateError extends Error {
    constructor(readonly code: string) {
      super(code)
    }
  }
  return {
    FilesDuplicateError,
    duplicateFilesEntry: jest.fn(async () => ({ kind: "upload", key: "upload:copy" })),
  }
})
jest.mock("@/lib/files-library/export-zip", () => {
  class FilesExportError extends Error {
    constructor(readonly code: string) {
      super(code)
    }
  }
  return {
    FilesExportError,
    buildFilesZip: jest.fn(async () => ({ blob: new Blob(["zip"]), written: 2, missing: [] })),
  }
})
jest.mock("@/lib/files-library/open", () => ({
  goToSession: jest.fn(async () => {}),
  openFilesEntry: jest.fn(async () => "preview"),
}))
jest.mock("@/lib/files-library/rename", () => {
  class FilesRenameError extends Error {
    constructor(readonly code: string) {
      super(code)
    }
  }
  return { FilesRenameError, renameFilesEntry: jest.fn(async () => {}) }
})
jest.mock("@/lib/files-library/trash", () => ({
  purgeTrashedItems: jest.fn(async () => ({ deleted: 1, retired: 0 })),
}))
jest.mock("@/lib/files-library/upload", () => ({ uploadFileToLibrary: jest.fn(async () => ({})) }))
jest.mock("@/lib/files-library/use-in-chat", () => {
  class FilesUseInChatError extends Error {
    constructor(readonly code: string) {
      super(code)
    }
  }
  return {
    FilesUseInChatError,
    attachEntryToSession: jest.fn(async () => "draft"),
    mentionCandidateFor: jest.fn((entry: { kind: string }) =>
      entry.kind === "artifact" ? {} : null
    ),
    resolveUseInChatTarget: jest.fn(async () => ({ session: { id: "s9" }, created: true })),
    stageEntryMention: jest.fn(async () => {}),
  }
})

import { toast } from "sonner"
import {
  LibraryItemError,
  restoreLibraryItems,
  setLibraryItemsFavorite,
  setLibraryItemsFolder,
  touchLibraryItemOpened,
  trashLibraryItems,
} from "@/lib/db/files-library-items"
import {
  LibraryFolderError,
  moveLibraryFolder,
  setLibraryFolderStyle,
} from "@/lib/db/files-library-folders"
import type { LibraryFolder } from "@/lib/db/files-library-types"
import { SessionAssetError } from "@/lib/db/session-assets"
import { downloadBlob } from "@/lib/files/download"
import { downloadPayloadFor } from "@/lib/files-library/download"
import { duplicateFilesEntry, FilesDuplicateError } from "@/lib/files-library/duplicate"
import { buildFilesZip, FilesExportError } from "@/lib/files-library/export-zip"
import { goToSession, openFilesEntry } from "@/lib/files-library/open"
import { FilesRenameError, renameFilesEntry } from "@/lib/files-library/rename"
import { purgeTrashedItems } from "@/lib/files-library/trash"
import type { FilesEntry } from "@/lib/files-library/types"
import { uploadFileToLibrary } from "@/lib/files-library/upload"
import { FilesWorkspaceFileError } from "@/lib/files-library/workspace-files-io"
import {
  attachEntryToSession,
  FilesUseInChatError,
  resolveUseInChatTarget,
  stageEntryMention,
} from "@/lib/files-library/use-in-chat"
import { useArtifactStore } from "@/stores/artifact/artifact-store"
import { useFilesLibraryStore } from "@/stores/files-library"
import { useProjectStore } from "@/stores/project/project-store"
import { useUIStore } from "@/stores/ui"
import { createLocalFilesOps, type FilesOps } from "@/lib/files-library/ops"
import { FilesRemoteError } from "@/lib/files-library/remote/client"
import { PAIRED_FILES_CAPABILITIES } from "@/lib/files-library/remote/remote-ops"
import { displayTitle, useFilesActions } from "./use-files-actions"

const success = toast.success as jest.Mock
const error = toast.error as jest.Mock

function entry(overrides: Partial<FilesEntry> = {}): FilesEntry {
  return {
    key: "artifact:a",
    kind: "artifact",
    sourceId: "a",
    title: "Parser",
    sourceTitle: "Parser",
    projectIds: [],
    sessionIds: [],
    originAlive: true,
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

const canvas = () => entry({ key: "canvas:c", kind: "canvas", sourceId: "c", title: "Notes" })

function hook() {
  return renderHook(() => useFilesActions()).result.current
}

beforeEach(() => {
  jest.clearAllMocks()
  useFilesLibraryStore.setState({ selectedKey: null })
  useProjectStore.setState({ activeProjectId: null } as never)
})

describe("open / preview", () => {
  it("previews: selects the entry and records the open", () => {
    const a = hook()
    act(() => a.preview(entry()))
    expect(useFilesLibraryStore.getState().selectedKey).toBe("artifact:a")
    expect(touchLibraryItemOpened).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "artifact", sourceId: "a" })
    )
  })

  it("a failed touch never blocks the open", async () => {
    ;(touchLibraryItemOpened as jest.Mock).mockRejectedValueOnce(new Error("db"))
    const h = hook()
    await act(() => h.open(entry()))
    expect(openFilesEntry).toHaveBeenCalled()
    expect(error).not.toHaveBeenCalled()
  })

  it("opens in place only when the target is the preview", async () => {
    const h = hook()
    await act(() => h.open(entry()))
    expect(openFilesEntry).toHaveBeenCalledWith(
      expect.objectContaining({ key: "artifact:a" }),
      expect.objectContaining({ push })
    )
    expect(useFilesLibraryStore.getState().selectedKey).toBe("artifact:a")
    ;(openFilesEntry as jest.Mock).mockResolvedValueOnce("canvas")
    useFilesLibraryStore.setState({ selectedKey: null })
    await act(() => h.open(entry()))
    expect(useFilesLibraryStore.getState().selectedKey).toBeNull()
  })

  it("reports a failed open", async () => {
    ;(openFilesEntry as jest.Mock).mockRejectedValueOnce(new Error("nav"))
    const h = hook()
    await act(() => h.open(entry()))
    expect(error).toHaveBeenCalledWith("Something went wrong. Try again.")
  })

  it("names a workspace file that left the disk", async () => {
    ;(openFilesEntry as jest.Mock).mockRejectedValueOnce(
      new FilesWorkspaceFileError("files_workspace_missing")
    )
    const h = hook()
    await act(() => h.open(entry({ kind: "workspace-file", key: "workspace-file:w" })))
    expect(error).toHaveBeenCalledWith("This file is no longer on disk.")
  })
})

describe("favorites", () => {
  it("toggles a single entry with a named toast", async () => {
    const a = hook()
    await a.toggleFavorite(entry())
    expect(setLibraryItemsFavorite).toHaveBeenCalledWith(
      [expect.objectContaining({ kind: "artifact", sourceId: "a" })],
      true
    )
    expect(success).toHaveBeenLastCalledWith("Added “Parser” to favorites.")
    await a.toggleFavorite(entry({ favoritedAt: 1 }))
    expect(setLibraryItemsFavorite).toHaveBeenLastCalledWith(expect.any(Array), false)
    expect(success).toHaveBeenLastCalledWith("Removed “Parser” from favorites.")
  })

  it("names an untitled entry by its kind", async () => {
    await hook().toggleFavorite(entry({ kind: "image", key: "image:i", title: "" }))
    expect(success).toHaveBeenLastCalledWith("Added “Untitled image” to favorites.")
  })

  it("bulk-favorites in one write with a counted toast", async () => {
    const a = hook()
    await a.setFavorite([entry(), canvas()], true)
    expect(setLibraryItemsFavorite).toHaveBeenCalledTimes(1)
    expect((setLibraryItemsFavorite as jest.Mock).mock.calls[0][0]).toHaveLength(2)
    expect(success).toHaveBeenLastCalledWith("Added 2 items to favorites.")
    await a.setFavorite([entry(), canvas()], false)
    expect(success).toHaveBeenLastCalledWith("Removed 2 items from favorites.")
  })

  it("does nothing for an empty selection", async () => {
    await hook().setFavorite([], true)
    expect(setLibraryItemsFavorite).not.toHaveBeenCalled()
    expect(success).not.toHaveBeenCalled()
  })
})

describe("moveToFolder", () => {
  it("files entries into a folder, or out of Folders", async () => {
    const a = hook()
    await a.moveToFolder([entry(), canvas()], "lbf_a")
    expect(setLibraryItemsFolder).toHaveBeenCalledWith(expect.any(Array), "lbf_a")
    expect(success).toHaveBeenLastCalledWith("Moved 2 items.")
    await a.moveToFolder([entry(), canvas()], null)
    expect(setLibraryItemsFolder).toHaveBeenLastCalledWith(expect.any(Array), null)
    expect(success).toHaveBeenLastCalledWith("Took 2 items out of Folders.")
    await a.moveToFolder([], "lbf_a")
    expect(setLibraryItemsFolder).toHaveBeenCalledTimes(2)
  })
})

describe("trash / restore / deleteForever", () => {
  it("trashes with an Undo that restores, and closes the preview of a trashed entry", async () => {
    useFilesLibraryStore.setState({ selectedKey: "artifact:a" })
    const h = hook()
    await act(() => h.trash([entry({ originAlive: false })]))
    expect(trashLibraryItems).toHaveBeenCalledWith([
      expect.objectContaining({ kind: "artifact", sourceId: "a" }),
    ])
    expect(useFilesLibraryStore.getState().selectedKey).toBeNull()
    const [message, options] = success.mock.calls.at(-1)!
    expect(message).toBe("Moved “Parser” to the Trash.")
    expect(options.description).toBe("Items stay in the Trash for 30 days.")
    expect(options.action.label).toBe("Undo")
    options.action.onClick()
    expect(restoreLibraryItems).toHaveBeenCalledWith([
      expect.objectContaining({ kind: "artifact", sourceId: "a", originAlive: false }),
    ])
  })

  it("keeps an unrelated preview open and counts a bulk trash", async () => {
    useFilesLibraryStore.setState({ selectedKey: "image:other" })
    const h = hook()
    await act(() => h.trash([entry(), canvas()]))
    expect(useFilesLibraryStore.getState().selectedKey).toBe("image:other")
    expect(success.mock.calls.at(-1)![0]).toBe("Moved 2 items to the Trash.")
  })

  it("reports a failed Undo", async () => {
    const h = hook()
    await act(() => h.trash([entry()]))
    ;(restoreLibraryItems as jest.Mock).mockRejectedValueOnce(
      new LibraryItemError("library_item_source_missing")
    )
    success.mock.calls.at(-1)![1].action.onClick()
    await act(async () => {})
    expect(error).toHaveBeenCalledWith("This item’s content is no longer stored on this device.")
  })

  it("does not toast or deselect when the trash write fails", async () => {
    useFilesLibraryStore.setState({ selectedKey: "artifact:a" })
    ;(trashLibraryItems as jest.Mock).mockRejectedValueOnce(new Error("db"))
    const h = hook()
    await act(() => h.trash([entry()]))
    expect(success).not.toHaveBeenCalled()
    expect(useFilesLibraryStore.getState().selectedKey).toBe("artifact:a")
    expect(error).toHaveBeenCalledWith("Something went wrong. Try again.")
  })

  it("restores with each entry's origin liveness", async () => {
    await hook().restore([entry(), canvas()])
    expect(restoreLibraryItems).toHaveBeenCalledWith([
      expect.objectContaining({ sourceId: "a", originAlive: true }),
      expect.objectContaining({ sourceId: "c", originAlive: true }),
    ])
    expect(success).toHaveBeenLastCalledWith("Restored 2 items.")
    await hook().restore([])
    expect(restoreLibraryItems).toHaveBeenCalledTimes(1)
  })

  it("deletes forever through the purge rule", async () => {
    useFilesLibraryStore.setState({ selectedKey: "upload:u" })
    const upload = entry({
      key: "upload:u",
      kind: "upload",
      sourceId: "u",
      ownedByFiles: true,
      trashedAt: 5,
    })
    const h = hook()
    await act(() => h.deleteForever([upload]))
    expect(purgeTrashedItems).toHaveBeenCalledWith([
      { key: "upload:u", kind: "upload", sourceId: "u", ownedByFiles: true, originAlive: true },
    ])
    expect(useFilesLibraryStore.getState().selectedKey).toBeNull()
    // The jest next-intl mock resolves only `=N` / `other` plural branches.
    expect(success).toHaveBeenLastCalledWith(
      expect.stringMatching(/^Deleted 1 items? forever\.$/),
      undefined
    )
  })

  it("explains items that stay in their conversation", async () => {
    ;(purgeTrashedItems as jest.Mock).mockResolvedValueOnce({ deleted: 1, retired: 2 })
    const h = hook()
    await act(() => h.deleteForever([entry(), canvas(), entry({ key: "artifact:b" })]))
    expect(success).toHaveBeenLastCalledWith("Deleted 3 items forever.", {
      description: "2 items stay in their conversations or on the canvas.",
    })
  })

  it("ignores an empty delete and reports a failed one", async () => {
    await hook().deleteForever([])
    expect(purgeTrashedItems).not.toHaveBeenCalled()
    ;(purgeTrashedItems as jest.Mock).mockRejectedValueOnce(
      new LibraryItemError("library_item_not_owned")
    )
    const h = hook()
    await act(() => h.deleteForever([entry()]))
    expect(error).toHaveBeenCalledWith("Only files uploaded to Files can be deleted here.")
  })
})

describe("rename / duplicate", () => {
  it("renames with the trimmed name and reports success", async () => {
    let ok = false
    const h = hook()
    await act(async () => {
      ok = await h.rename(entry(), "  Lexer  ")
    })
    expect(ok).toBe(true)
    expect(renameFilesEntry).toHaveBeenCalledWith(
      expect.objectContaining({ key: "artifact:a" }),
      "  Lexer  "
    )
    expect(success).toHaveBeenLastCalledWith("Renamed to “Lexer”.")
  })

  it("returns false with the mapped error when the rename is refused", async () => {
    ;(renameFilesEntry as jest.Mock).mockRejectedValueOnce(
      new FilesRenameError("files_name_required")
    )
    let ok = true
    const h = hook()
    await act(async () => {
      ok = await h.rename(entry(), "  ")
    })
    expect(ok).toBe(false)
    expect(error).toHaveBeenCalledWith("Enter a name.")
    expect(success).not.toHaveBeenCalled()
  })

  it("duplicates into the active workspace and selects an upload copy", async () => {
    useProjectStore.setState({ activeProjectId: "p1" } as never)
    const h = hook()
    await act(() => h.duplicate(entry()))
    expect(duplicateFilesEntry).toHaveBeenCalledWith(
      expect.objectContaining({ key: "artifact:a" }),
      {
        suffix: " (copy)",
        fallbackName: "Parser",
        projectId: "p1",
      }
    )
    expect(success).toHaveBeenLastCalledWith("Duplicated “Parser”.")
    expect(useFilesLibraryStore.getState().selectedKey).toBe("upload:copy")
  })

  it("does not select a canvas copy, and omits the workspace when none is active", async () => {
    ;(duplicateFilesEntry as jest.Mock).mockResolvedValueOnce({ kind: "canvas", id: "c2" })
    const h = hook()
    await act(() => h.duplicate(canvas()))
    expect(duplicateFilesEntry).toHaveBeenCalledWith(expect.anything(), {
      suffix: " (copy)",
      fallbackName: "Notes",
    })
    expect(useFilesLibraryStore.getState().selectedKey).toBeNull()
  })

  it("maps a duplicate of a vanished source", async () => {
    ;(duplicateFilesEntry as jest.Mock).mockRejectedValueOnce(
      new FilesDuplicateError("files_source_missing")
    )
    const h = hook()
    await act(() => h.duplicate(entry()))
    expect(error).toHaveBeenCalledWith("This item’s content is no longer stored on this device.")
  })
})

describe("download / exportZip", () => {
  it("downloads the payload and records the open", async () => {
    const blob = new Blob(["x"])
    ;(downloadPayloadFor as jest.Mock).mockResolvedValueOnce({ blob, filename: "Parser.ts" })
    await hook().download(entry())
    expect(downloadBlob).toHaveBeenCalledWith(blob, "Parser.ts")
    expect(touchLibraryItemOpened).toHaveBeenCalled()
  })

  it("says the bytes are gone when there is no payload", async () => {
    ;(downloadPayloadFor as jest.Mock).mockResolvedValueOnce(null)
    await hook().download(entry())
    expect(downloadBlob).not.toHaveBeenCalled()
    expect(touchLibraryItemOpened).not.toHaveBeenCalled()
    expect(error).toHaveBeenCalledWith("This item’s content is no longer stored on this device.")
  })

  it("reports a failed download", async () => {
    ;(downloadPayloadFor as jest.Mock).mockRejectedValueOnce(new Error("read"))
    await hook().download(entry())
    expect(error).toHaveBeenCalledWith("Something went wrong. Try again.")
  })

  const folders: LibraryFolder[] = [
    { id: "lbf_a", name: "A", parentFolderId: "root", createdAt: 1, updatedAt: 1 },
  ]

  it("shows progress, downloads the zip and dismisses the progress toast", async () => {
    await hook().exportZip([entry(), canvas()], folders)
    expect(toast.loading).toHaveBeenCalledWith("Preparing 2 items…")
    expect(buildFilesZip).toHaveBeenCalledWith([expect.anything(), expect.anything()], folders, {
      payloadFor: expect.any(Function),
    })
    expect(downloadBlob).toHaveBeenCalledWith(expect.any(Blob), "Files.zip")
    expect(success).toHaveBeenLastCalledWith("Downloaded 2 items as a zip.", undefined)
    expect(toast.dismiss).toHaveBeenCalledWith("t1")
  })

  it("names the items left out", async () => {
    ;(buildFilesZip as jest.Mock).mockResolvedValueOnce({
      blob: new Blob(["z"]),
      written: 2,
      missing: ["canvas:c", "canvas:d"],
    })
    await hook().exportZip([entry(), entry({ key: "artifact:b" }), canvas(), canvas()], folders)
    expect(success).toHaveBeenLastCalledWith("Downloaded 2 items as a zip.", {
      description: "2 items were left out: the content is no longer on this device.",
    })
  })

  it.each<[ConstructorParameters<typeof FilesExportError>[0], string]>([
    [
      "files_export_too_large",
      "The selection is larger than 512 MB. Download fewer items at a time.",
    ],
    ["files_export_empty", "None of the selected items could be exported."],
  ])("maps %s and still dismisses the progress toast", async (code, message) => {
    ;(buildFilesZip as jest.Mock).mockRejectedValueOnce(new FilesExportError(code))
    await hook().exportZip([entry()], [])
    expect(error).toHaveBeenCalledWith(message)
    expect(downloadBlob).not.toHaveBeenCalled()
    expect(toast.dismiss).toHaveBeenCalledWith("t1")
  })

  it("does nothing for an empty export", async () => {
    await hook().exportZip([], [])
    expect(toast.loading).not.toHaveBeenCalled()
    expect(buildFilesZip).not.toHaveBeenCalled()
  })
})

describe("useInChat / goToConversation", () => {
  it("references artifacts, then goes to the conversation", async () => {
    await hook().useInChat(entry())
    expect(resolveUseInChatTarget).toHaveBeenCalledWith("About Parser")
    expect(stageEntryMention).toHaveBeenCalledWith(
      expect.objectContaining({ key: "artifact:a" }),
      "s9"
    )
    expect(goToSession).toHaveBeenCalledWith("s9", expect.objectContaining({ push }))
    expect(success).toHaveBeenLastCalledWith("“Parser” is referenced in your next message.")
  })

  it("attaches files, or binds them when too large", async () => {
    const file = entry({ key: "upload:u", kind: "upload", sourceId: "u", title: "big.log" })
    await hook().useInChat(file)
    expect(attachEntryToSession).toHaveBeenCalledWith(file, "s9")
    expect(success).toHaveBeenLastCalledWith("“big.log” is attached to your next message.")
    ;(attachEntryToSession as jest.Mock).mockResolvedValueOnce("bound")
    await hook().useInChat(file)
    expect(success.mock.calls.at(-1)![0]).toMatch(/too large for the message box/)
  })

  it("maps attach failures and does not navigate", async () => {
    const file = entry({ key: "upload:u", kind: "upload", sourceId: "u", title: "big.log" })
    ;(attachEntryToSession as jest.Mock).mockRejectedValueOnce(
      new SessionAssetError("session_asset_quota_exceeded")
    )
    await hook().useInChat(file)
    expect(error).toHaveBeenLastCalledWith(
      "There isn’t room to store this file. Free up space in Settings → Storage."
    )
    ;(attachEntryToSession as jest.Mock).mockRejectedValueOnce(
      new FilesUseInChatError("files_not_attachable")
    )
    await hook().useInChat(file)
    expect(error).toHaveBeenLastCalledWith("This item can’t be used in a chat.")
    expect(goToSession).not.toHaveBeenCalled()
  })

  it("goes to a conversation, reporting a failure", async () => {
    await hook().goToConversation("s1")
    expect(goToSession).toHaveBeenCalledWith("s1", expect.objectContaining({ push }))
    ;(goToSession as jest.Mock).mockRejectedValueOnce(new Error("gone"))
    await hook().goToConversation("s2")
    expect(error).toHaveBeenCalledWith("Something went wrong. Try again.")
  })
})

describe("upload", () => {
  it("uploads into the active workspace and folder, reporting each failure", async () => {
    useProjectStore.setState({ activeProjectId: "p1" } as never)
    ;(uploadFileToLibrary as jest.Mock)
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new SessionAssetError("session_asset_too_large"))
      .mockResolvedValueOnce({})
    await hook().upload(
      [new File(["a"], "a.md"), new File(["b"], "b.iso"), new File(["c"], "c.md")],
      "lbf_a"
    )
    expect(toast.loading).toHaveBeenCalledWith("Uploading 3 files…")
    expect(uploadFileToLibrary).toHaveBeenCalledTimes(3)
    expect(uploadFileToLibrary).toHaveBeenCalledWith(expect.any(File), {
      projectId: "p1",
      folderId: "lbf_a",
    })
    expect(error).toHaveBeenCalledWith("Could not upload “b.iso”: The file is larger than 500 MB.")
    expect(toast.dismiss).toHaveBeenCalledWith("t1")
    expect(success).toHaveBeenLastCalledWith("Uploaded 2 files.")
  })

  it("passes no workspace or folder when neither applies, and no success when all fail", async () => {
    ;(uploadFileToLibrary as jest.Mock).mockRejectedValueOnce(new Error("boom"))
    await hook().upload([new File(["a"], "a.md")])
    expect(uploadFileToLibrary).toHaveBeenCalledWith(expect.any(File), {})
    expect(error).toHaveBeenCalledWith("Could not upload “a.md”: Something went wrong. Try again.")
    expect(success).not.toHaveBeenCalled()
    expect(toast.dismiss).toHaveBeenCalledWith("t1")
  })

  it("does nothing for no files", async () => {
    await hook().upload([])
    expect(uploadFileToLibrary).not.toHaveBeenCalled()
    expect(toast.loading).not.toHaveBeenCalled()
  })
})

describe("newCanvasDocument", () => {
  it("starts a user-made canvas document and opens Canvas", () => {
    const create = jest
      .spyOn(useArtifactStore.getState(), "createCanvasDocument")
      .mockReturnValue("c-new")
    const activate = jest
      .spyOn(useArtifactStore.getState(), "setActiveCanvas")
      .mockImplementation(() => {})
    hook().newCanvasDocument()
    expect(create).toHaveBeenCalledWith({
      createdBy: "user",
      title: "Untitled document",
      content: "",
      language: "markdown",
      type: "text",
    })
    expect(activate).toHaveBeenCalledWith("c-new")
    expect(useUIStore.getState().selectedGuild).toEqual({ kind: "canvas" })
    expect(push).toHaveBeenCalledWith("/")
    create.mockRestore()
    activate.mockRestore()
  })
})

describe("document templates", () => {
  const template = {
    id: "dtpl_p",
    source: "user" as const,
    name: "Postmortem",
    content: "# P",
    language: "markdown" as const,
    type: "text" as const,
    icon: "saved" as const,
  }

  it("starts a document from a template and opens Canvas", () => {
    const create = jest
      .spyOn(useArtifactStore.getState(), "createCanvasDocument")
      .mockReturnValue("c-tpl")
    const activate = jest
      .spyOn(useArtifactStore.getState(), "setActiveCanvas")
      .mockImplementation(() => {})
    hook().newFromTemplate(template)
    expect(create).toHaveBeenCalledWith({
      title: "Postmortem",
      content: "# P",
      language: "markdown",
      type: "text",
      createdBy: "user",
    })
    expect(activate).toHaveBeenCalledWith("c-tpl")
    expect(push).toHaveBeenCalledWith("/")
    create.mockRestore()
    activate.mockRestore()
  })

  it("deletes a saved template with an Undo that saves it again", async () => {
    const { deleteDocumentTemplate } = jest.requireMock("@/lib/db/document-templates") as {
      deleteDocumentTemplate: jest.Mock
    }
    const { saveDocumentAsTemplate } = jest.requireMock("@/lib/document-templates/service") as {
      saveDocumentAsTemplate: jest.Mock
    }
    const h = hook()
    await act(() => h.deleteTemplate(template))
    expect(deleteDocumentTemplate).toHaveBeenCalledWith("dtpl_p")
    const [message, options] = success.mock.calls.at(-1)!
    expect(message).toBe("Deleted the template “Postmortem”.")
    options.action.onClick()
    expect(saveDocumentAsTemplate).toHaveBeenCalledWith(template)
  })

  it("never deletes a built-in and maps a refused delete", async () => {
    const { deleteDocumentTemplate, DocumentTemplateError } = jest.requireMock(
      "@/lib/db/document-templates"
    ) as { deleteDocumentTemplate: jest.Mock; DocumentTemplateError: new (code: string) => Error }
    deleteDocumentTemplate.mockClear()
    await hook().deleteTemplate({ ...template, id: "guide", source: "builtin" })
    expect(deleteDocumentTemplate).not.toHaveBeenCalled()
    deleteDocumentTemplate.mockRejectedValueOnce(
      new DocumentTemplateError("document_template_not_found")
    )
    const h = hook()
    await act(() => h.deleteTemplate(template))
    expect(error).toHaveBeenLastCalledWith("That template no longer exists.")
  })
})

describe("folders", () => {
  it("moves a folder with a toast, mapping a cycle", async () => {
    await hook().moveFolder("lbf_a", "lbf_b")
    expect(moveLibraryFolder).toHaveBeenCalledWith("lbf_a", "lbf_b")
    expect(success).toHaveBeenLastCalledWith("Moved the folder.")
    ;(moveLibraryFolder as jest.Mock).mockRejectedValueOnce(
      new LibraryFolderError("library_folder_cycle")
    )
    await hook().moveFolder("lbf_a", "lbf_a")
    expect(error).toHaveBeenCalledWith("A folder can’t be moved into itself.")
  })

  it("restyles a folder silently, mapping a refused style", async () => {
    await hook().setFolderStyle("lbf_a", { color: "blue" as never, icon: null })
    expect(setLibraryFolderStyle).toHaveBeenCalledWith("lbf_a", { color: "blue", icon: null })
    expect(success).not.toHaveBeenCalled()
    ;(setLibraryFolderStyle as jest.Mock).mockRejectedValueOnce(
      new LibraryFolderError("library_folder_style_invalid")
    )
    await hook().setFolderStyle("lbf_a", { icon: "star" as never })
    expect(error).toHaveBeenCalledWith("That color or icon isn’t available.")
  })
})

describe("error mapping", () => {
  it("maps known error classes by code and anything else to the generic message", async () => {
    ;(setLibraryItemsFavorite as jest.Mock).mockRejectedValueOnce(
      new LibraryItemError("library_item_source_missing")
    )
    await hook().toggleFavorite(entry())
    expect(error).toHaveBeenLastCalledWith(
      "This item’s content is no longer stored on this device."
    )
    // A coded error of an unrecognised class is still "unknown".
    const foreign = Object.assign(new Error("x"), { code: "library_folder_cycle" })
    ;(setLibraryItemsFavorite as jest.Mock).mockRejectedValueOnce(foreign)
    await hook().toggleFavorite(entry())
    expect(error).toHaveBeenLastCalledWith("Something went wrong. Try again.")
    ;(setLibraryItemsFavorite as jest.Mock).mockRejectedValueOnce("string failure")
    await hook().toggleFavorite(entry())
    expect(error).toHaveBeenLastCalledWith("Something went wrong. Try again.")
  })
})

describe("on a paired device's library (ADR-0223 §9)", () => {
  const TEN_MIB = 10 * 1024 * 1024

  function remoteOps(over: Partial<FilesOps> = {}): FilesOps {
    return {
      ...createLocalFilesOps(),
      mode: "remote",
      capabilities: PAIRED_FILES_CAPABILITIES,
      touch: jest.fn(async () => {}),
      payloadFor: jest.fn(async () => ({ blob: new Blob(["x"]), filename: "x.txt" })),
      upload: jest.fn(async () => {}),
      useInChat: jest.fn(async () => ({ sessionId: "s-host", how: "bound" as const })),
      ...over,
    }
  }
  const remoteHook = (ops: FilesOps) => renderHook(() => useFilesActions(ops)).result.current

  it("opens in place: the item's own surface is the host's", async () => {
    await remoteHook(remoteOps()).open(entry())
    expect(openFilesEntry).not.toHaveBeenCalled()
    expect(useFilesLibraryStore.getState().selectedKey).toBe("artifact:a")
  })

  it("refuses to move anything over the ceiling, naming it", async () => {
    const ops = remoteOps()
    const big = entry({
      key: "upload:big",
      kind: "upload",
      title: "huge.mov",
      byteSize: TEN_MIB + 1,
    })
    await remoteHook(ops).download(big)
    expect(ops.payloadFor).not.toHaveBeenCalled()
    expect(error).toHaveBeenLastCalledWith("Larger than 10 MB. Open it on the desktop.")

    await remoteHook(ops).exportZip([entry(), big], [])
    expect(buildFilesZip).not.toHaveBeenCalled()
    expect(error).toHaveBeenLastCalledWith(
      "“huge.mov” is larger than 10 MB. Download it on the desktop."
    )
    const big2 = { ...big, key: "upload:big2", title: "b.mov" }
    await remoteHook(ops).exportZip([big, big2], [])
    expect(error).toHaveBeenLastCalledWith(
      "“huge.mov” and 1 more are larger than 10 MB. Download them on the desktop."
    )

    const file = new File(["x"], "clip.mov")
    Object.defineProperty(file, "size", { value: TEN_MIB + 1 })
    await remoteHook(ops).upload([file])
    expect(ops.upload).not.toHaveBeenCalled()
    expect(error.mock.calls.at(-1)![0]).toMatch(/Could not upload “clip\.mov”/)
  })

  it("zips through the library's own payloads", async () => {
    const ops = remoteOps()
    await remoteHook(ops).exportZip([entry()], [])
    expect((buildFilesZip as jest.Mock).mock.calls[0][2]).toEqual({ payloadFor: ops.payloadFor })
  })

  it("says a file was bound on the host", async () => {
    const file = entry({ key: "upload:u", kind: "upload", sourceId: "u", title: "notes.pdf" })
    await remoteHook(remoteOps()).useInChat(file)
    expect(success.mock.calls.at(-1)![0]).toMatch(
      /added to the conversation’s files on the desktop/
    )
    expect(goToSession).toHaveBeenCalledWith("s-host", expect.anything())
  })

  it("makes no documents where they are held back", () => {
    const create = jest.spyOn(useArtifactStore.getState(), "createCanvasDocument")
    const h = remoteHook(remoteOps())
    h.newCanvasDocument()
    h.newFromTemplate({
      id: "x",
      source: "builtin",
      name: "x",
      content: "",
      language: "markdown",
      type: "text",
      icon: "meeting",
    } as never)
    expect(create).not.toHaveBeenCalled()
    expect(push).not.toHaveBeenCalled()
    create.mockRestore()
  })

  it("maps the host's refusal codes, and an unknown one to the generic message", async () => {
    const ops = remoteOps({
      setFavorite: jest
        .fn()
        .mockRejectedValueOnce(new FilesRemoteError("headless_host"))
        .mockRejectedValueOnce(new FilesRemoteError("something_new")),
    })
    await remoteHook(ops).toggleFavorite(entry())
    expect(error).toHaveBeenLastCalledWith(
      "The paired host can’t manage its Files library. Open Files on the desktop app."
    )
    await remoteHook(ops).toggleFavorite(entry())
    expect(error).toHaveBeenLastCalledWith("Something went wrong. Try again.")
  })
})

it("names untitled entries by kind", () => {
  const t = (key: string) => `t:${key}`
  expect(displayTitle({ title: "", kind: "image" }, t)).toBe("t:untitled.image")
  expect(displayTitle({ title: "x", kind: "image" }, t)).toBe("x")
})
