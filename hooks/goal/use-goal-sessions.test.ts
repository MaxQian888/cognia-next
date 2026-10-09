/**
 * @jest-environment jsdom
 */
// Dexie's liveQuery needs an IndexedDB implementation present to run at all.
import "fake-indexeddb/auto"
import { act, renderHook, waitFor } from "@testing-library/react"
import type { ChatSession } from "@cognia/agent-config-types"

jest.mock("@/lib/db/sessions", () => ({ getSessionsByIds: jest.fn() }))

import { getSessionsByIds } from "@/lib/db/sessions"
import { useGoalSessions } from "./use-goal-sessions"

const getSessionsByIdsMock = getSessionsByIds as jest.Mock

function session(id: string): ChatSession {
  return { id, title: id, createdAt: 1, updatedAt: 1 } as ChatSession
}

beforeEach(() => {
  getSessionsByIdsMock.mockReset()
  getSessionsByIdsMock.mockImplementation(async (ids: string[]) =>
    ids.filter((id) => id !== "gone").map(session)
  )
})

describe("useGoalSessions", () => {
  it("is undefined while the goals themselves are loading, and reads nothing", async () => {
    const { result } = renderHook(() => useGoalSessions(undefined))
    // Give the live query a chance to run.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20))
    })
    expect(result.current).toBeUndefined()
    expect(getSessionsByIdsMock).not.toHaveBeenCalled()
  })

  it("resolves an empty map for no goals without a read", async () => {
    const { result } = renderHook(() => useGoalSessions([]))
    await waitFor(() => expect(result.current).toBeDefined())
    expect(result.current?.size).toBe(0)
    expect(getSessionsByIdsMock).not.toHaveBeenCalled()
  })

  it("reads the distinct session ids once, sorted, and maps them by id", async () => {
    const goals = [{ sessionId: "s2" }, { sessionId: "s1" }, { sessionId: "s2" }]
    const { result } = renderHook(() => useGoalSessions(goals))
    await waitFor(() => expect(result.current).toBeDefined())
    expect(getSessionsByIdsMock).toHaveBeenCalledTimes(1)
    expect(getSessionsByIdsMock).toHaveBeenCalledWith(["s1", "s2"])
    expect([...result.current!.keys()].sort()).toEqual(["s1", "s2"])
    expect(result.current!.get("s1")?.id).toBe("s1")
  })

  it("leaves a deleted conversation out of the map", async () => {
    const { result } = renderHook(() =>
      useGoalSessions([{ sessionId: "s1" }, { sessionId: "gone" }])
    )
    await waitFor(() => expect(result.current).toBeDefined())
    expect(result.current!.has("gone")).toBe(false)
    expect(result.current!.has("s1")).toBe(true)
  })

  it("does not re-read when the goals array is re-created with the same members", async () => {
    const { result, rerender } = renderHook(
      ({ goals }: { goals: { sessionId: string }[] }) => useGoalSessions(goals),
      { initialProps: { goals: [{ sessionId: "s1" }, { sessionId: "s2" }] } }
    )
    await waitFor(() => expect(result.current).toBeDefined())
    rerender({ goals: [{ sessionId: "s2" }, { sessionId: "s1" }] })
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20))
    })
    expect(getSessionsByIdsMock).toHaveBeenCalledTimes(1)

    rerender({ goals: [{ sessionId: "s3" }] })
    await waitFor(() => expect(result.current?.has("s3")).toBe(true))
    expect(getSessionsByIdsMock).toHaveBeenLastCalledWith(["s3"])
  })
})
