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
    deleteOwnedLibraryItem: jest.fn(async () => {}),
    hideLibraryItem: jest.fn(async () => {}),
    setLibraryItemFavorite: jest.fn(async () => {}),
    setLibraryItemFolder: jest.fn(async () => {}),
    touchLibraryItemOpened: jest.fn(async () => {}),
  }
})
jest.mock("@/lib/files/download", () => ({ downloadBlob: jest.fn() }))
jest.mock("@/lib/files-library/download", () => ({ downloadPayloadFor: jest.fn() }))
jest.mock("@/lib/files-library/open", () => ({
  goToSession: jest.fn(async () => {}),
  openFilesEntry: jest.fn(async () => "preview"),
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
  deleteOwnedLibraryItem,
  hideLibraryItem,
  LibraryItemError,
  setLibraryItemFavorite,
  setLibraryItemFolder,
  touchLibraryItemOpened,
} from "@/lib/db/files-library-items"
import { downloadBlob } from "@/lib/files/download"
import { downloadPayloadFor } from "@/lib/files-library/download"
import { goToSession, openFilesEntry } from "@/lib/files-library/open"
import type { FilesEntry } from "@/lib/files-library/types"
import { uploadFileToLibrary } from "@/lib/files-library/upload"
import {
  attachEntryToSession,
  resolveUseInChatTarget,
  stageEntryMention,
} from "@/lib/files-library/use-in-chat"
import { SessionAssetError } from "@/lib/db/session-assets"
import { useArtifactStore } from "@/stores/artifact/artifact-store"
import { useFilesLibraryStore } from "@/stores/files-library"
import { useProjectStore } from "@/stores/project/project-store"
import { useUIStore } from "@/stores/ui"
import { displayTitle, useFilesActions } from "./use-files-actions"

function entry(overrides: Partial<FilesEntry> = {}): FilesEntry {
  return {
    key: "artifact:a",
    kind: "artifact",
    sourceId: "a",
    title: "Parser",
    projectIds: [],
    sessionIds: [],
    originAlive: true,
    createdAt: 1,
    updatedAt: 1,
    ownedByFiles: false,
    hidden: false,
    searchText: "",
    ...overrides,
  }
}

function hook() {
  return renderHook(() => useFilesActions()).result.current
}

beforeEach(() => {
  jest.clearAllMocks()
  useFilesLibraryStore.setState({ selectedKey: null })
})

it("previews and records the open", async () => {
  const a = hook()
  act(() => a.preview(entry()))
  expect(useFilesLibraryStore.getState().selectedKey).toBe("artifact:a")
  expect(touchLibraryItemOpened).toHaveBeenCalledWith(
    expect.objectContaining({ kind: "artifact", sourceId: "a" })
  )
})

it("opens in place when there is no surface to leave for", async () => {
  await hook().open(entry())
  expect(openFilesEntry).toHaveBeenCalled()
  expect(useFilesLibraryStore.getState().selectedKey).toBe("artifact:a")
  ;(openFilesEntry as jest.Mock).mockResolvedValueOnce("canvas")
  useFilesLibraryStore.setState({ selectedKey: null })
  await hook().open(entry())
  expect(useFilesLibraryStore.getState().selectedKey).toBeNull()
})

it("favorites, unfavorites and files entries with a toast", async () => {
  const a = hook()
  await a.toggleFavorite(entry())
  expect(setLibraryItemFavorite).toHaveBeenCalledWith(expect.anything(), true)
  expect(toast.success).toHaveBeenCalledWith("Added “Parser” to favorites.")
  await a.toggleFavorite(entry({ favoritedAt: 1 }))
  expect(setLibraryItemFavorite).toHaveBeenLastCalledWith(expect.anything(), false)
  await a.moveToFolder(
    [entry(), entry({ key: "canvas:c", kind: "canvas", sourceId: "c" })],
    "lbf_a"
  )
  expect(setLibraryItemFolder).toHaveBeenCalledTimes(2)
  expect(toast.success).toHaveBeenLastCalledWith("Moved 2 items.")
  await a.moveToFolder([entry(), entry()], null)
  expect(toast.success).toHaveBeenLastCalledWith("Took 2 items out of Folders.")
})

it("maps a refused write to its message", async () => {
  ;(setLibraryItemFavorite as jest.Mock).mockRejectedValueOnce(
    new LibraryItemError("library_item_source_missing")
  )
  await hook().toggleFavorite(entry())
  expect(toast.error).toHaveBeenCalledWith(
    "This item’s content is no longer stored on this device."
  )
  ;(setLibraryItemFavorite as jest.Mock).mockRejectedValueOnce(new Error("boom"))
  await hook().toggleFavorite(entry())
  expect(toast.error).toHaveBeenLastCalledWith("Something went wrong. Try again.")
})

it("removes a conversation item and deletes a Files upload, closing their preview", async () => {
  useFilesLibraryStore.setState({ selectedKey: "artifact:a" })
  await hook().remove(entry())
  expect(hideLibraryItem).toHaveBeenCalled()
  expect(useFilesLibraryStore.getState().selectedKey).toBeNull()
  useFilesLibraryStore.setState({ selectedKey: "upload:u" })
  await hook().deleteOwned(
    entry({ key: "upload:u", kind: "upload", sourceId: "u", ownedByFiles: true })
  )
  expect(deleteOwnedLibraryItem).toHaveBeenCalledWith("upload:u")
  expect(useFilesLibraryStore.getState().selectedKey).toBeNull()
  expect(toast.success).toHaveBeenLastCalledWith("Deleted “Parser”.")
})

it("downloads the payload, or says the bytes are gone", async () => {
  const blob = new Blob(["x"])
  ;(downloadPayloadFor as jest.Mock).mockResolvedValueOnce({ blob, filename: "Parser.ts" })
  await hook().download(entry())
  expect(downloadBlob).toHaveBeenCalledWith(blob, "Parser.ts")
  ;(downloadPayloadFor as jest.Mock).mockResolvedValueOnce(null)
  await hook().download(entry())
  expect(toast.error).toHaveBeenCalledWith(
    "This item’s content is no longer stored on this device."
  )
})

it("references artifacts and attaches files, then goes to the conversation", async () => {
  await hook().useInChat(entry())
  expect(resolveUseInChatTarget).toHaveBeenCalledWith("About Parser")
  expect(stageEntryMention).toHaveBeenCalledWith(
    expect.objectContaining({ key: "artifact:a" }),
    "s9"
  )
  expect(goToSession).toHaveBeenCalledWith("s9", expect.anything())
  expect(toast.success).toHaveBeenLastCalledWith("“Parser” is referenced in your next message.")
  const file = entry({ key: "upload:u", kind: "upload", sourceId: "u", title: "big.log" })
  await hook().useInChat(file)
  expect(attachEntryToSession).toHaveBeenCalledWith(file, "s9")
  expect(toast.success).toHaveBeenLastCalledWith("“big.log” is attached to your next message.")
  ;(attachEntryToSession as jest.Mock).mockResolvedValueOnce("bound")
  await hook().useInChat(file)
  expect((toast.success as jest.Mock).mock.calls.at(-1)![0]).toMatch(
    /too large for the message box/
  )
  ;(attachEntryToSession as jest.Mock).mockRejectedValueOnce(
    new SessionAssetError("session_asset_quota_exceeded")
  )
  await hook().useInChat(file)
  expect(toast.error).toHaveBeenLastCalledWith(
    "There isn’t room to store this file. Free up space in Settings → Storage."
  )
})

it("uploads into the active workspace and reports each failure", async () => {
  useProjectStore.setState({ activeProjectId: "p1" } as never)
  ;(uploadFileToLibrary as jest.Mock)
    .mockResolvedValueOnce({})
    .mockRejectedValueOnce(new SessionAssetError("session_asset_too_large"))
    .mockResolvedValueOnce({})
  await hook().upload([new File(["a"], "a.md"), new File(["b"], "b.iso"), new File(["c"], "c.md")])
  expect(uploadFileToLibrary).toHaveBeenCalledWith(expect.any(File), { projectId: "p1" })
  expect(toast.error).toHaveBeenCalledWith(
    "Could not upload “b.iso”: The file is larger than 500 MB."
  )
  expect(toast.dismiss).toHaveBeenCalledWith("t1")
  expect(toast.success).toHaveBeenLastCalledWith("Uploaded 2 files.")
  jest.clearAllMocks()
  await hook().upload([])
  expect(uploadFileToLibrary).not.toHaveBeenCalled()
})

it("starts a standalone canvas document and opens Canvas", () => {
  const create = jest
    .spyOn(useArtifactStore.getState(), "createCanvasDocument")
    .mockReturnValue("c-new")
  const activate = jest
    .spyOn(useArtifactStore.getState(), "setActiveCanvas")
    .mockImplementation(() => {})
  hook().newCanvasDocument()
  expect(create).toHaveBeenCalledWith({
    title: "Untitled document",
    content: "",
    language: "markdown",
    type: "text",
  })
  expect(activate).toHaveBeenCalledWith("c-new")
  expect(useUIStore.getState().selectedGuild).toEqual({ kind: "canvas" })
  expect(push).toHaveBeenCalledWith("/")
})

it("names untitled entries by kind", () => {
  const t = (key: string) => `t:${key}`
  expect(displayTitle({ title: "", kind: "image" }, t)).toBe("t:untitled.image")
  expect(displayTitle({ title: "x", kind: "image" }, t)).toBe("x")
})
