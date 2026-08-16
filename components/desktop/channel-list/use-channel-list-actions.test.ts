/**
 * @jest-environment jsdom
 */
import { act, renderHook, waitFor } from "@testing-library/react"
import type { SessionFolder } from "@cognia/agent-config-types"
import {
  trackConversationCreated,
  trackConversationRowAction,
} from "@/lib/telemetry/conversation-list-events"
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

jest.mock("@/lib/telemetry/conversation-list-events", () => ({
  trackConversationCreated: jest.fn(() => Promise.resolve(true)),
  trackConversationRowAction: jest.fn(() => Promise.resolve(true)),
}))

const trackCreated = jest.mocked(trackConversationCreated)
const trackRowAction = jest.mocked(trackConversationRowAction)

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

  it("tracks and delegates every row and bulk action", async () => {
    const handlers = callbacks()
    const { result } = renderHook(() =>
      useChannelListActions({
        ...handlers,
        folders: [],
        newFolderName: "New folder",
      })
    )
    const actions = result.current.rowActions

    actions.onDelete("one")
    actions.onRename("one", "Renamed")
    actions.onTogglePinned?.("one", true)
    actions.onTogglePinned?.("one", false)
    actions.onArchive?.("one")
    actions.onUnarchive?.("one")
    actions.onAssignToFolder?.("one", "folder-a")
    actions.onAssignToFolder?.("one", null)
    actions.onBulkDelete?.(["one", "two"])
    actions.onBulkSetPinned?.(["one", "two"], true)
    actions.onBulkSetPinned?.(["one"], false)
    actions.onBulkArchive?.(["one", "two"])
    actions.onBulkUnarchive?.(["one"])
    await actions.onBulkAssignToFolder?.(["one", "two"], "folder-a")
    await actions.onBulkAssignToFolder?.(["one"], null)

    expect(handlers.onRename).toHaveBeenCalledWith("one", "Renamed")
    expect(handlers.onAssignToFolder).toHaveBeenCalledWith("two", "folder-a")
    expect(trackRowAction).toHaveBeenCalledWith("pin")
    expect(trackRowAction).toHaveBeenCalledWith("unassign-folder")
    expect(trackRowAction).toHaveBeenCalledWith("delete", 2)
    expect(trackRowAction).toHaveBeenCalledWith("assign-folder", 2)
    expect(trackRowAction).toHaveBeenCalledWith("unassign-folder", 1)
  })

  it("keeps optional actions absent when their callbacks are absent", () => {
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

    expect(result.current.rowActions).toEqual(
      expect.objectContaining({
        onTogglePinned: undefined,
        onArchive: undefined,
        onUnarchive: undefined,
        onAssignToFolder: undefined,
        onBulkDelete: undefined,
        onBulkSetPinned: undefined,
        onBulkArchive: undefined,
        onBulkUnarchive: undefined,
        onBulkAssignToFolder: undefined,
      })
    )
    expect(result.current.handleMoveFolder).toBeUndefined()
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
      expect(logWarn).toHaveBeenCalledWith("channel-list create folder failed", {
        error: "Error: create failed",
      })
    )
    expect(result.current.renamingFolderId).toBeNull()
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
    expect(handlers.onReorderFolders).toHaveBeenCalledWith(["two", "one", "three"])
    await waitFor(() =>
      expect(logWarn).toHaveBeenCalledWith("channel-list folder reorder failed", {
        error: "Error: write failed",
      })
    )

    act(() => {
      result.current.handleMoveFolder?.("one", -1)
      result.current.handleMoveFolder?.("missing", 1)
    })
    expect(handlers.onReorderFolders).toHaveBeenCalledTimes(1)
  })
})
