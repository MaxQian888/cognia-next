/**
 * @jest-environment jsdom
 */
import { act, renderHook } from "@testing-library/react"
import type { ChatSession } from "@cognia/agent-config-types"

jest.mock("@/hooks/chat/use-session-archive-actions", () => {
  const unarchive = jest.fn(async () => true)
  const archive = jest.fn(async () => true)
  return { useSessionArchiveActions: () => ({ archive, unarchive }), __unarchive: unarchive }
})

import { useUnarchiveOnUserTurn } from "./use-unarchive-on-user-turn"

const { __unarchive: unarchiveMock } = jest.requireMock(
  "@/hooks/chat/use-session-archive-actions"
) as { __unarchive: jest.Mock }

function row(patch: Partial<ChatSession> = {}): ChatSession {
  return { id: "s1", title: "T", createdAt: 0, updatedAt: 0, ...patch } as ChatSession
}

beforeEach(() => {
  unarchiveMock.mockReset().mockResolvedValue(true)
})

describe("useUnarchiveOnUserTurn", () => {
  it("restores an archived conversation as a send", () => {
    const session = row({ archivedAt: 5 })
    const { result } = renderHook(() => useUnarchiveOnUserTurn(session))
    act(() => result.current())
    expect(unarchiveMock).toHaveBeenCalledWith([session], { reason: "send" })
  })

  it("does nothing for an active conversation or no conversation", () => {
    const { result, rerender } = renderHook(
      ({ session }: { session: ChatSession | null }) => useUnarchiveOnUserTurn(session),
      { initialProps: { session: row() as ChatSession | null } }
    )
    act(() => result.current())
    rerender({ session: null })
    act(() => result.current())
    expect(unarchiveMock).not.toHaveBeenCalled()
  })

  it("leaves a handed-off conversation to the write guard", () => {
    const session = row({
      archivedAt: 5,
      handoffLock: { ticketId: "t" } as ChatSession["handoffLock"],
    })
    const { result } = renderHook(() => useUnarchiveOnUserTurn(session))
    act(() => result.current())
    expect(unarchiveMock).not.toHaveBeenCalled()
  })

  it("restores once per archive, even while the row prop is still stale", async () => {
    const session = row({ archivedAt: 5 })
    const { result, rerender } = renderHook(
      ({ s }: { s: ChatSession }) => useUnarchiveOnUserTurn(s),
      { initialProps: { s: session } }
    )
    await act(async () => result.current())
    await act(async () => result.current())
    expect(unarchiveMock).toHaveBeenCalledTimes(1)
    // Archived again (an Undo stamps a new time): the next turn restores again.
    rerender({ s: row({ archivedAt: 9 }) })
    await act(async () => result.current())
    expect(unarchiveMock).toHaveBeenCalledTimes(2)
  })

  it("retries on the next turn after a refused or failed restore, and never throws", async () => {
    unarchiveMock.mockResolvedValueOnce(false).mockRejectedValueOnce(new Error("boom"))
    const session = row({ archivedAt: 5 })
    const { result } = renderHook(() => useUnarchiveOnUserTurn(session))
    await act(async () => result.current())
    await act(async () => result.current())
    await act(async () => result.current())
    expect(unarchiveMock).toHaveBeenCalledTimes(3)
  })

  it("keeps one callback identity and reads the latest row", () => {
    const { result, rerender } = renderHook(
      ({ s }: { s: ChatSession }) => useUnarchiveOnUserTurn(s),
      { initialProps: { s: row() } }
    )
    const first = result.current
    const archived = row({ archivedAt: 7 })
    rerender({ s: archived })
    expect(result.current).toBe(first)
    act(() => result.current())
    expect(unarchiveMock).toHaveBeenCalledWith([archived], { reason: "send" })
  })
})
