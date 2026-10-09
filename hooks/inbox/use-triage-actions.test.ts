/**
 * @jest-environment jsdom
 */

import { act, renderHook } from "@testing-library/react"

jest.mock("sonner", () => ({
  toast: { success: jest.fn(), warning: jest.fn(), error: jest.fn() },
}))
jest.mock("@/hooks/chat/use-sessions", () => ({
  useSessions: jest.fn(),
}))
jest.mock("@/lib/connectors/inbox-writes", () => ({
  mutateConversationOverride: jest.fn(),
}))
jest.mock("@/lib/connectors/assignment/notify-assignment", () => ({
  notifyAssignmentChanged: jest.fn(),
}))
jest.mock("@/lib/db/session-state", () => ({
  markSessionRead: jest.fn(),
  markSessionUnread: jest.fn(),
}))

import { toast } from "sonner"
import { useSessions } from "@/hooks/chat/use-sessions"
import { mutateConversationOverride } from "@/lib/connectors/inbox-writes"
import { notifyAssignmentChanged } from "@/lib/connectors/assignment/notify-assignment"
import { markSessionRead, markSessionUnread } from "@/lib/db/session-state"
import type { TriageTarget } from "@/lib/inbox/bulk-triage"
import { useTriageActions } from "./use-triage-actions"

const mockToast = toast as unknown as {
  success: jest.Mock
  warning: jest.Mock
  error: jest.Mock
}
const mockMutate = mutateConversationOverride as jest.Mock
const mockNotify = notifyAssignmentChanged as jest.Mock
const mockRead = markSessionRead as jest.Mock
const mockUnread = markSessionUnread as jest.Mock
const bulkSetPinned = jest.fn(async (_ids: readonly string[], _pinned: boolean) => {})
const archive = jest.fn(async (_id: string) => {})
const unarchive = jest.fn(async (_id: string) => {})

function target(id: string, extra: Partial<TriageTarget> = {}): TriageTarget {
  return {
    sessionId: id,
    conversationKey: `tg:a1:${id}`,
    adapterId: "a1",
    status: "open",
    labelIds: [],
    pinned: false,
    archived: false,
    unread: false,
    ...extra,
  }
}

beforeEach(() => {
  jest.clearAllMocks()
  ;(useSessions as jest.Mock).mockReturnValue({ bulkSetPinned, archive, unarchive })
  mockMutate.mockResolvedValue({ route: "local", conversationKey: "k" })
  mockNotify.mockResolvedValue(undefined)
  mockRead.mockResolvedValue(undefined)
  mockUnread.mockResolvedValue(undefined)
})

describe("useTriageActions", () => {
  it("binds the session and override writers", async () => {
    const { result } = renderHook(() => useTriageActions())
    await act(async () => {
      await result.current.run({ kind: "markRead" }, [target("a", { unread: true })])
      await result.current.run({ kind: "markUnread" }, [target("a")])
      await result.current.run({ kind: "setPinned", pinned: true }, [target("a")])
      await result.current.run({ kind: "setArchived", archived: true }, [target("a")])
      await result.current.run({ kind: "setArchived", archived: false }, [
        target("b", { archived: true }),
      ])
      await result.current.run({ kind: "addLabel", labelId: "l1" }, [target("a")])
      await result.current.run({ kind: "removeLabel", labelId: "l1" }, [
        target("a", { labelIds: ["l1"] }),
      ])
      await result.current.run({ kind: "setStatus", status: "snoozed", snoozeUntil: 9 }, [
        target("a"),
      ])
    })
    expect(mockRead).toHaveBeenCalledWith("a")
    expect(mockUnread).toHaveBeenCalledWith("a")
    expect(bulkSetPinned).toHaveBeenCalledWith(["a"], true)
    expect(archive).toHaveBeenCalledWith("a")
    expect(unarchive).toHaveBeenCalledWith("b")
    expect(mockMutate).toHaveBeenCalledWith({
      kind: "addLabel",
      conversationKey: "tg:a1:a",
      sessionId: "a",
      labelId: "l1",
    })
    expect(mockMutate).toHaveBeenCalledWith({
      kind: "removeLabel",
      conversationKey: "tg:a1:a",
      sessionId: "a",
      labelId: "l1",
    })
    expect(mockMutate).toHaveBeenCalledWith({
      kind: "setStatus",
      conversationKey: "tg:a1:a",
      sessionId: "a",
      status: "snoozed",
      snoozeUntil: 9,
    })
  })

  it("assigns through the override write with manual provenance and notifies one change", async () => {
    const { result } = renderHook(() => useTriageActions())
    await act(async () => {
      await result.current.run({ kind: "setAssignee", assignee: { kind: "human" } }, [target("a")])
    })
    expect(mockMutate).toHaveBeenCalledWith({
      kind: "setAssignee",
      conversationKey: "tg:a1:a",
      sessionId: "a",
      assignee: { kind: "human" },
      via: "manual",
      adapterId: "a1",
    })
    expect(mockNotify).toHaveBeenCalledWith({
      conversationKey: "tg:a1:a",
      from: null,
      to: { kind: "human" },
      via: "manual",
    })
  })

  it("stays silent for a single in-place change", async () => {
    const { result } = renderHook(() => useTriageActions())
    await act(async () => {
      await result.current.run({ kind: "markRead" }, [target("a", { unread: true })])
    })
    expect(mockToast.success).not.toHaveBeenCalled()
  })

  it("summarises a bulk change with its count", async () => {
    const { result } = renderHook(() => useTriageActions())
    await act(async () => {
      await result.current.run({ kind: "markRead" }, [
        target("a", { unread: true }),
        target("b", { unread: true }),
      ])
    })
    expect(mockToast.success).toHaveBeenCalledWith("Marked 2 conversations as read", undefined)
  })

  it("offers Undo after a resolve and restores the previous status", async () => {
    const { result } = renderHook(() => useTriageActions())
    await act(async () => {
      await result.current.run({ kind: "setStatus", status: "resolved" }, [
        target("a", { status: "pending" }),
      ])
    })
    expect(mockToast.success).toHaveBeenCalledWith(
      "Conversation resolved",
      expect.objectContaining({ action: expect.objectContaining({ label: "Undo" }) })
    )
    const { action } = mockToast.success.mock.calls[0]![1] as {
      action: { onClick: () => void }
    }
    mockMutate.mockClear()
    await act(async () => {
      action.onClick()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(mockMutate).toHaveBeenCalledWith({
      kind: "setStatus",
      conversationKey: "tg:a1:a",
      sessionId: "a",
      status: "pending",
      snoozeUntil: undefined,
    })
    expect(mockToast.success).toHaveBeenLastCalledWith("Change undone")
  })

  it("offers Undo after an archive", async () => {
    const { result } = renderHook(() => useTriageActions())
    await act(async () => {
      await result.current.run({ kind: "setArchived", archived: true }, [target("a")])
    })
    const { action } = mockToast.success.mock.calls[0]![1] as {
      action: { onClick: () => void }
    }
    await act(async () => {
      action.onClick()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(unarchive).toHaveBeenCalledWith("a")
  })

  it("reports an undo that fails", async () => {
    const { result } = renderHook(() => useTriageActions())
    await act(async () => {
      await result.current.run({ kind: "setArchived", archived: true }, [target("a")])
    })
    unarchive.mockRejectedValueOnce(new Error("nope"))
    const { action } = mockToast.success.mock.calls[0]![1] as {
      action: { onClick: () => void }
    }
    await act(async () => {
      action.onClick()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(mockToast.error).toHaveBeenCalledWith("Couldn't undo 1 change")
  })

  it("reports a partial failure and keeps the undo for what landed", async () => {
    mockRead.mockImplementation(async (id: string) => {
      if (id === "b") throw new Error("relay dropped")
    })
    const { result } = renderHook(() => useTriageActions())
    let outcome: Awaited<ReturnType<typeof result.current.run>> | undefined
    await act(async () => {
      outcome = await result.current.run({ kind: "markRead" }, [
        target("a", { unread: true }),
        target("b", { unread: true }),
      ])
    })
    expect(outcome!.failed).toHaveLength(1)
    expect(mockToast.warning).toHaveBeenCalledWith("Marked as read", {
      description: "1 conversation couldn't be updated",
    })
  })

  it("reports a total failure with the first error", async () => {
    mockMutate.mockRejectedValue(new Error("Inbox write unavailable"))
    const { result } = renderHook(() => useTriageActions())
    await act(async () => {
      await result.current.run({ kind: "setStatus", status: "pending" }, [target("a")])
    })
    expect(mockToast.error).toHaveBeenCalledWith("Couldn't update the conversation", {
      description: "Nothing was changed for those conversations. Try again.",
    })
  })

  it("says nothing when every target already matched", async () => {
    const { result } = renderHook(() => useTriageActions())
    await act(async () => {
      await result.current.run({ kind: "markRead" }, [target("a"), target("b")])
    })
    expect(mockRead).not.toHaveBeenCalled()
    expect(mockToast.success).not.toHaveBeenCalled()
    expect(mockToast.error).not.toHaveBeenCalled()
  })
})
