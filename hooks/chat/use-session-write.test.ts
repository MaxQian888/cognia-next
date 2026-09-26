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
  useTranslations: () => (key: string) => key,
}))

import { SessionHandoffLockedError } from "@/lib/chat/session-write-guard"
import { isSessionHandoffLocked, isSessionWriteBlocked, useSessionWrite } from "./use-session-write"

const row = (id: string, over: Partial<ChatSession> = {}): ChatSession =>
  ({ id, title: id, kind: "direct", createdAt: 1, updatedAt: 1, ...over }) as ChatSession

const LOCK = { ticketId: "tk", lockedAt: 1 } as unknown as ChatSession["handoffLock"]

beforeEach(() => {
  toastError.mockReset()
  toastSuccess.mockReset()
})

describe("isSessionHandoffLocked", () => {
  it("recognizes the guard's error and its wire shape", () => {
    expect(isSessionHandoffLocked(new SessionHandoffLockedError("s", "t", "metadata"))).toBe(true)
    expect(isSessionHandoffLocked({ code: "session_handoff_locked" })).toBe(true)
    expect(isSessionHandoffLocked(new Error("disk full"))).toBe(false)
    expect(isSessionHandoffLocked(null)).toBe(false)
  })
})

describe("isSessionWriteBlocked", () => {
  it("blocks conversation writes on a locked row", () => {
    expect(isSessionWriteBlocked("delete", [row("a"), row("b", { handoffLock: LOCK })])).toBe(true)
    expect(isSessionWriteBlocked("rename", [row("a")])).toBe(false)
  })

  it("never blocks the reader's own unread state", () => {
    expect(isSessionWriteBlocked("markRead", [row("a", { handoffLock: LOCK })])).toBe(false)
    expect(isSessionWriteBlocked("markUnread", [row("a", { handoffLock: LOCK })])).toBe(false)
  })
})

describe("useSessionWrite", () => {
  it("runs the write and reports success", async () => {
    const write = jest.fn().mockResolvedValue(undefined)
    const { result } = renderHook(() => useSessionWrite())
    let ok = false
    await act(async () => {
      ok = await result.current("pin", row("a"), write, { success: "Pinned" })
    })
    expect(ok).toBe(true)
    expect(write).toHaveBeenCalledTimes(1)
    expect(toastSuccess).toHaveBeenCalledWith("Pinned", undefined)
    expect(toastError).not.toHaveBeenCalled()
  })

  it("stays silent on success when no confirmation is asked for", async () => {
    const { result } = renderHook(() => useSessionWrite())
    await act(async () => {
      await result.current("rename", row("a"), () => undefined)
    })
    expect(toastSuccess).not.toHaveBeenCalled()
  })

  it("refuses a locked row before the write runs", async () => {
    const write = jest.fn()
    const { result } = renderHook(() => useSessionWrite())
    let ok = true
    await act(async () => {
      ok = await result.current("archive", [row("a"), row("b", { handoffLock: LOCK })], write)
    })
    expect(ok).toBe(false)
    expect(write).not.toHaveBeenCalled()
    expect(toastError).toHaveBeenCalledWith("actionLocked")
  })

  it("names a lock that landed after render as a lock, not a failure", async () => {
    const { result } = renderHook(() => useSessionWrite())
    await act(async () => {
      await result.current("delete", row("a"), () => {
        throw new SessionHandoffLockedError("a", "tk", "delete")
      })
    })
    expect(toastError).toHaveBeenCalledWith("actionLocked")
  })

  it("toasts a failed write with the action's message and the cause", async () => {
    const { result } = renderHook(() => useSessionWrite())
    let ok = true
    await act(async () => {
      ok = await result.current("branch", row("a"), () => Promise.reject(new Error("disk full")))
    })
    expect(ok).toBe(false)
    expect(toastError).toHaveBeenCalledWith("actionFailed.branch", { description: "disk full" })
  })

  it("offers an undo that surfaces its own failure", async () => {
    const { result } = renderHook(() => useSessionWrite())
    const undoRun = jest.fn().mockRejectedValue(new Error("gone"))
    await act(async () => {
      await result.current("archive", row("a"), () => undefined, {
        success: "Archived",
        undo: { label: "Undo", run: undoRun },
      })
    })
    const options = toastSuccess.mock.calls[0]![1] as {
      action: { label: string; onClick: () => void }
    }
    expect(options.action.label).toBe("Undo")
    await act(async () => {
      options.action.onClick()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(undoRun).toHaveBeenCalledTimes(1)
    expect(toastError).toHaveBeenCalledWith("undoFailed", { description: "gone" })
  })
})
