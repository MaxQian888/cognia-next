/**
 * @jest-environment jsdom
 */
// Dexie's liveQuery needs an IndexedDB implementation present to run at all.
import "fake-indexeddb/auto"
import { act, renderHook, waitFor } from "@testing-library/react"
import type { Goal } from "@/types/goal"

jest.mock("@/lib/db/goals", () => ({ listGoalsForSessions: jest.fn() }))

import { listGoalsForSessions } from "@/lib/db/goals"
import { pickSessionGoals, useSessionGoals } from "./use-session-goals"

const listGoalsForSessionsMock = listGoalsForSessions as jest.Mock

function goal(id: string, overrides: Partial<Goal> = {}): Goal {
  return {
    id,
    sessionId: "s1",
    rawObjective: "obj",
    safeObjective: "obj",
    redactionMapEnc: "",
    status: "completed",
    turnsUsed: 0,
    tokensUsed: 0,
    judgeFailureCount: 0,
    config: { maxTurns: 20, maxTokens: 200_000, maxJudgeFailures: 3, timeoutMs: 1_800_000 },
    generationId: "gen",
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

describe("pickSessionGoals", () => {
  it("prefers the open goal over a newer finished one, in either input order", () => {
    const open = goal("open", { status: "paused", createdAt: 10 })
    const newerDone = goal("done", { status: "completed", createdAt: 99 })
    expect(pickSessionGoals([open, newerDone]).get("s1")?.id).toBe("open")
    expect(pickSessionGoals([newerDone, open]).get("s1")?.id).toBe("open")
  })

  it("picks the newest among finished goals", () => {
    const rows = [
      goal("old", { status: "completed", createdAt: 1 }),
      goal("newest", { status: "stopped" as Goal["status"], createdAt: 30 }),
      goal("mid", { status: "completed", createdAt: 20 }),
    ]
    expect(pickSessionGoals(rows).get("s1")?.id).toBe("newest")
  })

  it("picks the newest among open goals", () => {
    const rows = [
      goal("older-open", { status: "paused", createdAt: 5 }),
      goal("newer-open", { status: "active", createdAt: 8 }),
    ]
    expect(pickSessionGoals(rows).get("s1")?.id).toBe("newer-open")
    expect(pickSessionGoals([...rows].reverse()).get("s1")?.id).toBe("newer-open")
  })

  it("keeps one goal per conversation", () => {
    const picked = pickSessionGoals([
      goal("a", { sessionId: "s1", status: "active" }),
      goal("b", { sessionId: "s2" }),
      goal("c", { sessionId: "s2", createdAt: 5 }),
    ])
    expect(picked.size).toBe(2)
    expect(picked.get("s1")?.id).toBe("a")
    expect(picked.get("s2")?.id).toBe("c")
  })

  it("is empty for no goals", () => {
    expect(pickSessionGoals([]).size).toBe(0)
  })
})

describe("useSessionGoals", () => {
  beforeEach(() => {
    listGoalsForSessionsMock.mockReset()
  })

  it("reads the drawn ids, sorted, and maps each conversation to its goal", async () => {
    listGoalsForSessionsMock.mockResolvedValue([
      goal("open", { sessionId: "s2", status: "active", createdAt: 1 }),
      goal("done", { sessionId: "s2", createdAt: 9 }),
      goal("only", { sessionId: "s1" }),
    ])
    const ids = ["s2", "s1", "s3"]
    const { result } = renderHook(() => useSessionGoals(ids))
    await waitFor(() => expect(result.current.size).toBe(2))
    expect(listGoalsForSessionsMock).toHaveBeenCalledWith(["s1", "s2", "s3"])
    expect(result.current.get("s2")?.id).toBe("open")
    expect(result.current.get("s1")?.id).toBe("only")
    expect(result.current.has("s3")).toBe(false)
  })

  it("does not read when no conversations are drawn", async () => {
    const { result } = renderHook(() => useSessionGoals([]))
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20))
    })
    expect(result.current.size).toBe(0)
    expect(listGoalsForSessionsMock).not.toHaveBeenCalled()
  })
})
