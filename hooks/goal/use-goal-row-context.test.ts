/**
 * @jest-environment jsdom
 */
// Dexie's liveQuery needs an IndexedDB implementation present to run at all.
import "fake-indexeddb/auto"
import { renderHook, waitFor } from "@testing-library/react"
import type { ChatSession } from "@cognia/agent-config-types"
import type { Goal } from "@/types/goal"

jest.mock("@/lib/db/sessions", () => ({ getSessionsByIds: jest.fn() }))
jest.mock("@/lib/db/goals", () => ({ latestJudgeReasons: jest.fn() }))
jest.mock("@/lib/data-hooks/context", () => ({ useCharacters: jest.fn() }))

import { useCharacters } from "@/lib/data-hooks/context"
import { latestJudgeReasons } from "@/lib/db/goals"
import { getSessionsByIds } from "@/lib/db/sessions"
import { useGoalRowContext } from "./use-goal-row-context"

const getSessionsByIdsMock = getSessionsByIds as jest.Mock
const latestJudgeReasonsMock = latestJudgeReasons as jest.Mock
const useCharactersMock = useCharacters as jest.Mock

function goal(id: string, overrides: Partial<Goal> = {}): Goal {
  return {
    id,
    sessionId: `s-${id}`,
    rawObjective: "obj",
    safeObjective: "obj",
    redactionMapEnc: "",
    status: "active",
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

beforeEach(() => {
  jest.clearAllMocks()
  getSessionsByIdsMock.mockImplementation(async (ids: string[]) =>
    ids
      .filter((id) => id !== "s-gone")
      .map((id) => ({ id, title: id, createdAt: 1, updatedAt: 1 }) as ChatSession)
  )
  latestJudgeReasonsMock.mockImplementation(
    async (ids: string[]) =>
      new Map(ids.filter((id) => id === "g1").map((id) => [id, "close, not done"]))
  )
  useCharactersMock.mockReturnValue([
    { id: "c1", name: "Researcher" },
    { id: "c2", name: "Coder" },
  ])
})

describe("useGoalRowContext", () => {
  it("reports sessions as loading (undefined) before goals arrive", () => {
    const { result } = renderHook(() => useGoalRowContext(undefined))
    expect(result.current.sessionFor({ sessionId: "s-g1" })).toBeUndefined()
    expect(result.current.judgeNoteFor({ id: "g1" })).toBeNull()
  })

  it("resolves the conversation, null for a deleted one", async () => {
    const goals = [goal("g1"), goal("g2", { sessionId: "s-gone" })]
    const { result } = renderHook(() => useGoalRowContext(goals))
    await waitFor(() => expect(result.current.sessionFor(goals[0]!)).toBeDefined())
    expect(result.current.sessionFor(goals[0]!)?.id).toBe("s-g1")
    expect(result.current.sessionFor(goals[1]!)).toBeNull()
  })

  it("names the agent from the characters list", () => {
    const { result } = renderHook(() => useGoalRowContext([goal("g1")]))
    expect(result.current.agentNameFor({ characterId: "c2" })).toBe("Coder")
    expect(result.current.agentNameFor({ characterId: "missing" })).toBeUndefined()
    expect(result.current.agentNameFor({})).toBeUndefined()
  })

  it("tolerates characters that have not loaded", () => {
    useCharactersMock.mockReturnValue(undefined)
    const { result } = renderHook(() => useGoalRowContext([goal("g1")]))
    expect(result.current.agentNameFor({ characterId: "c1" })).toBeUndefined()
  })

  it("does not read judge verdicts unless asked", async () => {
    const goals = [goal("g1")]
    const { result } = renderHook(() => useGoalRowContext(goals))
    await waitFor(() => expect(result.current.sessionFor(goals[0]!)).toBeDefined())
    expect(latestJudgeReasonsMock).not.toHaveBeenCalled()
    expect(result.current.judgeNoteFor({ id: "g1" })).toBeNull()
  })

  it("reads judge verdicts for the whole list in one call when asked", async () => {
    const goals = [goal("g1"), goal("g2")]
    const { result } = renderHook(() => useGoalRowContext(goals, { judgeNotes: true }))
    await waitFor(() => expect(result.current.judgeNoteFor({ id: "g1" })).toBe("close, not done"))
    expect(latestJudgeReasonsMock).toHaveBeenCalledTimes(1)
    expect(latestJudgeReasonsMock).toHaveBeenCalledWith(["g1", "g2"])
    expect(result.current.judgeNoteFor({ id: "g2" })).toBeNull()
  })
})
