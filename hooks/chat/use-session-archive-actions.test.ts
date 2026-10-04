/** @jest-environment jsdom */

import { act, renderHook } from "@testing-library/react"
import type { ChatSession } from "@cognia/agent-config-types"

const toastError = jest.fn()
const toastSuccess = jest.fn()
jest.mock("sonner", () => ({
  toast: {
    error: (...args: unknown[]) => toastError(...args),
    success: (...args: unknown[]) => toastSuccess(...args),
  },
}))
jest.mock("next-intl", () => ({
  useTranslations: (ns: string) => (key: string, values?: Record<string, unknown>) =>
    values ? `${ns}.${key}:${JSON.stringify(values)}` : `${ns}.${key}`,
}))

const setArchivedMock = jest.fn()
jest.mock("@/lib/chat/session-archive-writes", () => ({
  setSessionsArchived: (ids: readonly string[], archived: boolean) =>
    setArchivedMock(ids, archived),
}))

const trackMock = jest.fn()
jest.mock("@/lib/telemetry/conversation-list-events", () => ({
  trackConversationRowAction: (...args: unknown[]) => trackMock(...args),
}))

import { useSessionArchiveActions } from "./use-session-archive-actions"

const row = (id: string, over: Partial<ChatSession> = {}): ChatSession =>
  ({ id, title: id, kind: "direct", createdAt: 1, updatedAt: 1, ...over }) as ChatSession

const LOCK = { ticketId: "tk", lockedAt: 1 } as unknown as ChatSession["handoffLock"]

beforeEach(() => {
  toastError.mockReset()
  toastSuccess.mockReset()
  setArchivedMock.mockReset().mockResolvedValue(undefined)
  trackMock.mockReset().mockResolvedValue(true)
})

/** The Undo the last success toast offered. */
function lastUndo(): () => void {
  const options = toastSuccess.mock.calls.at(-1)?.[1] as { action: { onClick: () => void } }
  return options.action.onClick
}

describe("useSessionArchiveActions", () => {
  it("archives only the active rows and offers an undo that restores them", async () => {
    const { result } = renderHook(() => useSessionArchiveActions())
    let ok = false
    await act(async () => {
      ok = await result.current.archive([row("a"), row("b", { archivedAt: 5 })])
    })
    expect(ok).toBe(true)
    expect(setArchivedMock).toHaveBeenCalledWith(["a"], true)
    expect(trackMock).toHaveBeenCalledWith("archive", 1)
    expect(toastSuccess.mock.calls[0]![0]).toBe(
      'desktop.channelList.bulk.archiveSuccess:{"count":1}'
    )
    await act(async () => {
      lastUndo()()
    })
    expect(setArchivedMock).toHaveBeenLastCalledWith(["a"], false)
  })

  it("restores archived rows with the list's own confirmation", async () => {
    const { result } = renderHook(() => useSessionArchiveActions())
    await act(async () => {
      await result.current.unarchive([row("a", { archivedAt: 1 }), row("b", { archivedAt: 2 })])
    })
    expect(setArchivedMock).toHaveBeenCalledWith(["a", "b"], false)
    expect(toastSuccess.mock.calls[0]![0]).toBe(
      'desktop.channelList.bulk.unarchiveSuccess:{"count":2}'
    )
    await act(async () => {
      lastUndo()()
    })
    expect(setArchivedMock).toHaveBeenLastCalledWith(["a", "b"], true)
  })

  it("says where the conversation went when a send restored it", async () => {
    const { result } = renderHook(() => useSessionArchiveActions())
    await act(async () => {
      await result.current.unarchive([row("a", { archivedAt: 1 })], { reason: "send" })
    })
    expect(toastSuccess.mock.calls[0]![0]).toBe("conversations.archive.restoredBySend")
  })

  it("does nothing, successfully, when no row changes sides", async () => {
    const { result } = renderHook(() => useSessionArchiveActions())
    let ok = false
    await act(async () => {
      ok = await result.current.unarchive([row("a")])
    })
    expect(ok).toBe(true)
    expect(setArchivedMock).not.toHaveBeenCalled()
    expect(toastSuccess).not.toHaveBeenCalled()
  })

  it("refuses a handed-off conversation before writing", async () => {
    const { result } = renderHook(() => useSessionArchiveActions())
    let ok = true
    await act(async () => {
      ok = await result.current.archive([row("a", { handoffLock: LOCK })])
    })
    expect(ok).toBe(false)
    expect(setArchivedMock).not.toHaveBeenCalled()
    expect(toastError).toHaveBeenCalledWith("chat.sessionWrite.actionLocked")
  })

  it("resolves false and toasts when the write fails", async () => {
    setArchivedMock.mockRejectedValue(new Error("disk full"))
    const { result } = renderHook(() => useSessionArchiveActions())
    let ok = true
    await act(async () => {
      ok = await result.current.unarchive([row("a", { archivedAt: 1 })])
    })
    expect(ok).toBe(false)
    expect(toastError).toHaveBeenCalledWith("chat.sessionWrite.actionFailed.unarchive", {
      description: "disk full",
    })
  })
})
