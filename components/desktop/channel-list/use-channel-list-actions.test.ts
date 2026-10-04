/**
 * @jest-environment jsdom
 */
import { act, renderHook, waitFor } from "@testing-library/react"
import type { SessionFolder } from "@cognia/agent-config-types"
import { trackConversationCreated } from "@/lib/telemetry/conversation-list-events"
import { useChannelListActions } from "./use-channel-list-actions"

const logInfo = jest.fn()
const logWarn = jest.fn()

jest.mock("@cognia/logging", () => ({
  loggers: {
    ui: {
      info: (...args: unknown[]) => logInfo(...args),
      warn: (...args: unknown[]) => logWarn(...args),
    },
  },
}))

const toastSuccess = jest.fn()
const toastError = jest.fn()
const toastInfo = jest.fn()
jest.mock("sonner", () => ({
  toast: {
    success: (...args: unknown[]) => toastSuccess(...args),
    error: (...args: unknown[]) => toastError(...args),
    info: (...args: unknown[]) => toastInfo(...args),
  },
}))
jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key,
}))
const markSessionRead = jest.fn(async (_id: string) => {})
const markSessionUnread = jest.fn(async (_id: string) => {})
jest.mock("@/lib/db/session-state", () => ({
  markSessionRead: (id: string) => markSessionRead(id),
  markSessionUnread: (id: string) => markSessionUnread(id),
}))
const writeClipboardText = jest.fn(async (_text: string) => {})
jest.mock("@/lib/tauri/clipboard", () => ({
  writeClipboardText: (text: string) => writeClipboardText(text),
}))
let tauri = false
jest.mock("@/lib/tauri", () => ({ isTauri: () => tauri }))

jest.mock("@/lib/telemetry/conversation-list-events", () => ({
  trackConversationCreated: jest.fn(() => Promise.resolve(true)),
  trackConversationRowAction: jest.fn(() => Promise.resolve(true)),
}))

const trackCreated = jest.mocked(trackConversationCreated)

function folder(id: string): SessionFolder {
  return { id } as SessionFolder
}

function callbacks() {
  return {
    onNewDirect: jest.fn(),
    onNewTeamConversation: jest.fn(),
    onDelete: jest.fn(),
    onRename: jest.fn(),
    onTogglePinned: jest.fn(),
    onArchive: jest.fn(),
    onUnarchive: jest.fn(),
    onBulkDelete: jest.fn(),
    onBulkSetPinned: jest.fn(),
    onBulkArchive: jest.fn(),
    onBulkUnarchive: jest.fn(),
    onCreateFolder: jest.fn(),
    onReorderFolders: jest.fn(),
    onAssignToFolder: jest.fn(),
  }
}

describe("useChannelListActions", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    tauri = false
  })

  it("tracks and delegates conversation creation", () => {
    const handlers = callbacks()
    const { result } = renderHook(() =>
      useChannelListActions({
        ...handlers,
        folders: [],
        newFolderName: "New folder",
      })
    )

    act(() => {
      result.current.handleNewDirect()
      result.current.handleNewTeamConversation("team-a")
    })

    expect(trackCreated).toHaveBeenNthCalledWith(1, "direct")
    expect(trackCreated).toHaveBeenNthCalledWith(2, "team")
    expect(handlers.onNewDirect).toHaveBeenCalledTimes(1)
    expect(handlers.onNewTeamConversation).toHaveBeenCalledWith("team-a")
    expect(logInfo).toHaveBeenCalledWith("channel-list new-team-conversation", {
      teamId: "team-a",
    })
  })

  it("opens a newly created folder for rename and settles only that folder", async () => {
    const handlers = callbacks()
    handlers.onCreateFolder.mockResolvedValue(folder("created"))
    const { result } = renderHook(() =>
      useChannelListActions({
        ...handlers,
        folders: [],
        newFolderName: "New folder",
      })
    )

    act(() => result.current.handleNewFolder())
    await waitFor(() => expect(result.current.renamingFolderId).toBe("created"))
    expect(handlers.onCreateFolder).toHaveBeenCalledWith("New folder")

    act(() => result.current.handleFolderRenameSettled("other"))
    expect(result.current.renamingFolderId).toBe("created")
    act(() => result.current.handleFolderRenameSettled("created"))
    expect(result.current.renamingFolderId).toBeNull()
  })

  it("logs rejected folder creation without entering rename mode", async () => {
    const handlers = callbacks()
    handlers.onCreateFolder.mockRejectedValue(new Error("create failed"))
    const { result } = renderHook(() =>
      useChannelListActions({
        ...handlers,
        folders: [],
        newFolderName: "New folder",
      })
    )

    act(() => result.current.handleNewFolder())
    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith("actionFailed.folderCreate", {
        description: "create failed",
      })
    )
    expect(logWarn).toHaveBeenCalledWith(
      "session write failed",
      expect.objectContaining({ action: "folderCreate", error: "create failed" })
    )
    expect(result.current.renamingFolderId).toBeNull()
  })

  it("creates a folder for the given rows, files them, then opens its name", async () => {
    const handlers = callbacks()
    handlers.onCreateFolder.mockResolvedValue(folder("made"))
    const { result } = renderHook(() =>
      useChannelListActions({
        ...handlers,
        folders: [],
        newFolderName: "New folder",
      })
    )
    let ok: boolean | undefined
    await act(async () => {
      ok = await result.current.handleNewFolderWith?.(["one", "two"])
    })
    expect(ok).toBe(true)
    expect(handlers.onCreateFolder).toHaveBeenCalledWith("New folder")
    // No batch writer here: the boundary files the rows one by one, in order.
    expect(handlers.onAssignToFolder.mock.calls).toEqual([
      ["one", "made"],
      ["two", "made"],
    ])
    expect(result.current.renamingFolderId).toBe("made")
    expect(toastSuccess).toHaveBeenCalledWith('moveSuccess:{"count":2}', undefined)
  })

  it("files nothing and opens no editor when the folder could not be made", async () => {
    const handlers = callbacks()
    handlers.onCreateFolder.mockRejectedValue(new Error("create failed"))
    const { result } = renderHook(() =>
      useChannelListActions({ ...handlers, folders: [], newFolderName: "New folder" })
    )
    let ok: boolean | undefined
    await act(async () => {
      ok = await result.current.handleNewFolderWith?.(["one"])
    })
    expect(ok).toBe(false)
    expect(handlers.onAssignToFolder).not.toHaveBeenCalled()
    expect(result.current.renamingFolderId).toBeNull()
  })

  it("reports a failed filing but still opens the new folder's name", async () => {
    const handlers = callbacks()
    handlers.onCreateFolder.mockResolvedValue(folder("made"))
    handlers.onAssignToFolder.mockRejectedValue(new Error("move failed"))
    const { result } = renderHook(() =>
      useChannelListActions({ ...handlers, folders: [], newFolderName: "New folder" })
    )
    let ok: boolean | undefined
    await act(async () => {
      ok = await result.current.handleNewFolderWith?.(["one"])
    })
    expect(ok).toBe(false)
    expect(result.current.renamingFolderId).toBe("made")
  })

  it("makes nothing for an empty set of rows", async () => {
    const handlers = callbacks()
    const { result } = renderHook(() =>
      useChannelListActions({ ...handlers, folders: [], newFolderName: "New folder" })
    )
    let ok: boolean | undefined
    await act(async () => {
      ok = await result.current.handleNewFolderWith?.([])
    })
    expect(ok).toBe(false)
    expect(handlers.onCreateFolder).not.toHaveBeenCalled()
  })

  it("offers no new-folder-with path without a way to file rows", () => {
    const handlers = callbacks()
    const { result } = renderHook(() =>
      useChannelListActions({
        ...handlers,
        onAssignToFolder: undefined,
        folders: [],
        newFolderName: "New folder",
      })
    )
    expect(result.current.handleNewFolderWith).toBeUndefined()
  })

  it("offers no new-folder-with path without a folder creator", () => {
    const handlers = callbacks()
    const { result } = renderHook(() =>
      useChannelListActions({
        ...handlers,
        onCreateFolder: undefined,
        folders: [],
        newFolderName: "New folder",
      })
    )
    expect(result.current.handleNewFolderWith).toBeUndefined()
  })

  it("reorders folders within bounds and logs persistence failures", async () => {
    const handlers = callbacks()
    handlers.onReorderFolders.mockRejectedValue(new Error("write failed"))
    const { result } = renderHook(() =>
      useChannelListActions({
        ...handlers,
        folders: [folder("one"), folder("two"), folder("three")],
        newFolderName: "New folder",
      })
    )

    act(() => result.current.handleMoveFolder?.("two", -1))
    await waitFor(() =>
      expect(handlers.onReorderFolders).toHaveBeenCalledWith(["two", "one", "three"])
    )
    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith("actionFailed.reorder", {
        description: "write failed",
      })
    )

    act(() => {
      result.current.handleMoveFolder?.("one", -1)
      result.current.handleMoveFolder?.("missing", 1)
    })
    expect(handlers.onReorderFolders).toHaveBeenCalledTimes(1)
  })

  it("offers folder moves only with an owner writer and at least two folders", () => {
    const handlers = callbacks()
    const { result } = renderHook(() =>
      useChannelListActions({
        onNewDirect: handlers.onNewDirect,
        onNewTeamConversation: handlers.onNewTeamConversation,
        onDelete: handlers.onDelete,
        onRename: handlers.onRename,
        folders: [folder("one")],
        newFolderName: "New folder",
      })
    )
    expect(result.current.handleMoveFolder).toBeUndefined()
  })

  it("hands out the shared row boundary's actions", () => {
    const handlers = callbacks()
    const { result } = renderHook(() =>
      useChannelListActions({ ...handlers, folders: [], newFolderName: "New folder" })
    )
    result.current.rowActions.onRename("one", "Renamed")
    expect(handlers.onRename).toHaveBeenCalledWith("one", "Renamed")
    expect(result.current.extraActions.onCopyLink).toBeDefined()
    expect(result.current.exportSessionId).toBeNull()
  })
})
