/**
 * @jest-environment jsdom
 */
import { act, renderHook, waitFor } from "@testing-library/react"
import type { ChatSession } from "@cognia/agent-config-types"
import { trackConversationRowAction } from "@/lib/telemetry/conversation-list-events"
import { useConversationRowActions } from "./use-conversation-row-actions"

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

const trackRowAction = jest.mocked(trackConversationRowAction)

function row(id: string, over: Partial<ChatSession> = {}): ChatSession {
  return { id, title: id, kind: "direct", createdAt: 1, updatedAt: 1, ...over } as ChatSession
}

const LOCK = { ticketId: "tk", lockedAt: 1 } as unknown as ChatSession["handoffLock"]

/** Rows by id for the hook's call-time lookups. */
function lookup(rows: ChatSession[]) {
  const byId = new Map(rows.map((r) => [r.id, r]))
  return (ids: readonly string[]) =>
    ids.flatMap((id) => {
      const found = byId.get(id)
      return found ? [found] : []
    })
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

describe("useConversationRowActions", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    tauri = false
  })

  it("tracks and delegates every row and bulk action", async () => {
    const handlers = callbacks()
    const { result } = renderHook(() =>
      useConversationRowActions({
        ...handlers,
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

  it("files a selection through the batch writer when the owner has one", async () => {
    const handlers = callbacks()
    const onBulkAssignToFolder = jest.fn(async () => {})
    const { result } = renderHook(() =>
      useConversationRowActions({
        ...handlers,
        onBulkAssignToFolder,
      })
    )
    await result.current.rowActions.onBulkAssignToFolder?.(["one", "two"], "folder-a")
    // One call for the whole selection, and no per-row writes beside it.
    expect(onBulkAssignToFolder).toHaveBeenCalledTimes(1)
    expect(onBulkAssignToFolder).toHaveBeenCalledWith(["one", "two"], "folder-a")
    expect(handlers.onAssignToFolder).not.toHaveBeenCalled()
    expect(trackRowAction).toHaveBeenCalledWith("assign-folder", 2)
  })

  it("offers the bulk move with only a batch writer, and stops a per-row move at a failure", async () => {
    const onBulkAssignToFolder = jest.fn(async () => {})
    const handlers = callbacks()
    const { result: batchOnly } = renderHook(() =>
      useConversationRowActions({
        onDelete: handlers.onDelete,
        onRename: handlers.onRename,
        onBulkAssignToFolder,
      })
    )
    expect(batchOnly.current.rowActions.onBulkAssignToFolder).toBeDefined()

    const onAssignToFolder = jest
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("locked"))
    const { result: perRow } = renderHook(() =>
      useConversationRowActions({
        ...handlers,
        onAssignToFolder,
      })
    )
    // The boundary never rejects: the failure is toasted and reported as `false`.
    await expect(
      perRow.current.rowActions.onBulkAssignToFolder?.(["a", "b", "c"], "f")
    ).resolves.toBe(false)
    expect(onAssignToFolder.mock.calls.map(([id]) => id)).toEqual(["a", "b"])
    expect(toastError).toHaveBeenCalledWith("actionFailed.move", { description: "locked" })
  })

  it("keeps optional actions absent when their callbacks are absent", () => {
    const handlers = callbacks()
    const { result } = renderHook(() =>
      useConversationRowActions({
        onDelete: handlers.onDelete,
        onRename: handlers.onRename,
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
  })

  describe("write boundary", () => {
    it("refuses a handed-off conversation before the owner's writer runs", async () => {
      const handlers = callbacks()
      const { result } = renderHook(() =>
        useConversationRowActions({
          ...handlers,
          resolveSessions: lookup([row("one", { handoffLock: LOCK })]),
        })
      )
      await expect(result.current.rowActions.onDelete("one")).resolves.toBe(false)
      await expect(result.current.rowActions.onBulkArchive?.(["one"])).resolves.toBe(false)
      expect(handlers.onDelete).not.toHaveBeenCalled()
      expect(handlers.onBulkArchive).not.toHaveBeenCalled()
      expect(toastError).toHaveBeenCalledWith("actionLocked")
    })

    it("confirms single and bulk writes with the same words", async () => {
      const handlers = callbacks()
      const { result } = renderHook(() => useConversationRowActions({ ...handlers }))
      await act(async () => {
        await result.current.rowActions.onTogglePinned?.("one", true)
        await result.current.rowActions.onBulkSetPinned?.(["one", "two"], false)
        await result.current.rowActions.onBulkDelete?.(["one", "two"])
      })
      expect(toastSuccess).toHaveBeenCalledWith('pinSuccess:{"count":1}', undefined)
      expect(toastSuccess).toHaveBeenCalledWith('unpinSuccess:{"count":2}', undefined)
      expect(toastSuccess).toHaveBeenCalledWith('deleteSuccess:{"count":2}', undefined)
    })

    it("confirms a single-row folder move and a removal from a folder", async () => {
      const handlers = callbacks()
      const { result } = renderHook(() => useConversationRowActions({ ...handlers }))
      await act(async () => {
        await result.current.rowActions.onAssignToFolder?.("one", "folder-a")
        await result.current.rowActions.onAssignToFolder?.("one", null)
      })
      expect(toastSuccess).toHaveBeenCalledWith('moveSuccess:{"count":1}', undefined)
      expect(toastSuccess).toHaveBeenCalledWith('removeFromFolderSuccess:{"count":1}', undefined)
    })

    it("offers an undo on archive that restores the row", async () => {
      const handlers = callbacks()
      const { result } = renderHook(() => useConversationRowActions({ ...handlers }))
      await act(async () => {
        await result.current.rowActions.onArchive?.("one")
      })
      const [message, options] = toastSuccess.mock.calls[0]!
      expect(message).toBe('archiveSuccess:{"count":1}')
      const undo = (options as { action: { label: string; onClick: () => void } }).action
      expect(undo.label).toBe("undo")
      await act(async () => {
        undo.onClick()
        await Promise.resolve()
      })
      await waitFor(() => expect(handlers.onUnarchive).toHaveBeenCalledWith("one"))
    })

    it("opens the next row when the open conversation is deleted or archived", async () => {
      const handlers = callbacks()
      const onSelect = jest.fn()
      const { result } = renderHook(() =>
        useConversationRowActions({
          ...handlers,
          activeSessionId: "b",
          getRenderedOrder: () => ["a", "b", "c"],
          onSelect,
        })
      )
      await act(async () => {
        await result.current.rowActions.onDelete("b")
      })
      expect(onSelect).toHaveBeenCalledWith("c")
      onSelect.mockClear()
      await act(async () => {
        await result.current.rowActions.onBulkArchive?.(["b", "c"])
      })
      expect(onSelect).toHaveBeenCalledWith("a")
    })

    it("stays put when the removal fails or leaves the open conversation alone", async () => {
      const handlers = callbacks()
      handlers.onDelete.mockRejectedValueOnce(new Error("nope"))
      const onSelect = jest.fn()
      const { result } = renderHook(() =>
        useConversationRowActions({
          ...handlers,
          activeSessionId: "b",
          getRenderedOrder: () => ["a", "b", "c"],
          onSelect,
        })
      )
      await act(async () => {
        await result.current.rowActions.onDelete("b")
        await result.current.rowActions.onDelete("a")
      })
      expect(onSelect).not.toHaveBeenCalled()
    })

    it("keeps its handlers stable across renders", () => {
      const handlers = callbacks()
      const { result, rerender } = renderHook(
        ({ active }: { active: string }) =>
          useConversationRowActions({
            ...handlers,
            onDelete: jest.fn(),
            activeSessionId: active,
          }),
        { initialProps: { active: "a" } }
      )
      const first = result.current
      rerender({ active: "b" })
      expect(result.current.rowActions).toBe(first.rowActions)
      expect(result.current.extraActions).toBe(first.extraActions)
    })
  })

  describe("folders", () => {
    it("forgets a deleted folder's view state only when the delete lands", async () => {
      const onFolderDeleted = jest.fn()
      const onDeleteFolder = jest
        .fn()
        .mockRejectedValueOnce(new Error("locked member"))
        .mockResolvedValueOnce(undefined)
      const { result } = renderHook(() =>
        useConversationRowActions({
          ...callbacks(),
          onDeleteFolder,
          onFolderDeleted,
        })
      )
      await act(async () => {
        await result.current.rowActions.onDeleteFolder?.("f1")
      })
      expect(onFolderDeleted).not.toHaveBeenCalled()
      expect(toastError).toHaveBeenCalledWith("actionFailed.folderDelete", {
        description: "locked member",
      })
      await act(async () => {
        await result.current.rowActions.onDeleteFolder?.("f1")
      })
      expect(onFolderDeleted).toHaveBeenCalledWith("f1")
    })

    it("reports a failed folder rename", async () => {
      const { result } = renderHook(() =>
        useConversationRowActions({
          ...callbacks(),
          onRenameFolder: jest.fn().mockRejectedValue(new Error("disk")),
        })
      )
      await expect(result.current.rowActions.onRenameFolder?.("f1", "X")).resolves.toBe(false)
      expect(toastError).toHaveBeenCalledWith("actionFailed.folderRename", { description: "disk" })
    })
  })

  describe("row extras", () => {
    it("marks a row read or unread — even while it is handed off", async () => {
      const { result } = renderHook(() =>
        useConversationRowActions({
          ...callbacks(),
          resolveSessions: lookup([row("one", { handoffLock: LOCK })]),
        })
      )
      act(() => {
        result.current.extraActions.onMarkUnread?.("one")
        result.current.extraActions.onMarkRead?.("one")
      })
      await waitFor(() => expect(markSessionUnread).toHaveBeenCalledWith("one"))
      await waitFor(() => expect(markSessionRead).toHaveBeenCalledWith("one"))
      expect(trackRowAction).toHaveBeenCalledWith("mark-unread")
    })

    it("marks a selection read in one action", async () => {
      const { result } = renderHook(() => useConversationRowActions({ ...callbacks() }))
      await act(async () => {
        await result.current.rowActions.onBulkMarkRead(["one", "two"])
      })
      expect(markSessionRead.mock.calls.map(([id]) => id)).toEqual(["one", "two"])
      expect(trackRowAction).toHaveBeenCalledWith("mark-read", 2)
    })

    it("branches a conversation, opens the branch and says so", async () => {
      const onSelect = jest.fn()
      const onBranch = jest.fn(async () => row("child"))
      const { result } = renderHook(() =>
        useConversationRowActions({
          ...callbacks(),
          onBranch,
          onSelect,
        })
      )
      act(() => result.current.extraActions.onBranch?.("parent"))
      await waitFor(() => expect(onSelect).toHaveBeenCalledWith("child"))
      expect(onBranch).toHaveBeenCalledWith("parent")
      expect(toastSuccess).toHaveBeenCalledWith("branched")
    })

    it("says there is nothing to branch in an empty conversation", async () => {
      const onSelect = jest.fn()
      const { result } = renderHook(() =>
        useConversationRowActions({
          ...callbacks(),
          onBranch: jest.fn(async () => null),
          onSelect,
        })
      )
      act(() => result.current.extraActions.onBranch?.("parent"))
      await waitFor(() => expect(toastInfo).toHaveBeenCalledWith("nothingToBranch"))
      expect(onSelect).not.toHaveBeenCalled()
    })

    it("offers no branch without an owner writer", () => {
      const { result } = renderHook(() => useConversationRowActions({ ...callbacks() }))
      expect(result.current.extraActions.onBranch).toBeUndefined()
    })

    it("copies the scheme link on the desktop and an origin link on the web", async () => {
      const { result } = renderHook(() => useConversationRowActions({ ...callbacks() }))
      tauri = true
      act(() => result.current.extraActions.onCopyLink?.("s_1"))
      await waitFor(() => expect(writeClipboardText).toHaveBeenCalledWith("cognia://session/s_1"))
      tauri = false
      act(() => result.current.extraActions.onCopyLink?.("s_1"))
      await waitFor(() =>
        expect(writeClipboardText).toHaveBeenLastCalledWith(
          `${window.location.origin}/?session=s_1`
        )
      )
      expect(toastSuccess).toHaveBeenCalledWith("linkCopied")
    })

    it("reports a clipboard failure", async () => {
      writeClipboardText.mockRejectedValueOnce(new Error("denied"))
      const { result } = renderHook(() => useConversationRowActions({ ...callbacks() }))
      act(() => result.current.extraActions.onCopyLink?.("s_1"))
      await waitFor(() => expect(toastError).toHaveBeenCalledWith("linkCopyFailed"))
    })

    it("opens and closes the export dialog for one row", () => {
      const { result } = renderHook(() => useConversationRowActions({ ...callbacks() }))
      act(() => result.current.extraActions.onExportShare?.("s_1"))
      expect(result.current.exportSessionId).toBe("s_1")
      act(() => result.current.closeExport())
      expect(result.current.exportSessionId).toBeNull()
    })
  })
})
