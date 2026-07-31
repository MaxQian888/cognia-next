import "fake-indexeddb/auto"
import { renderHook, waitFor } from "@testing-library/react"
import { __resetDbForTesting, getDb, whenSeeded } from "@/lib/db/schema"
import { createGoal } from "@/lib/db/goals"
import type { Goal } from "@/types/goal"
import { useOpenGoal } from "./use-active-goal"

const CONFIG: Goal["config"] = {
  maxTurns: 20,
  maxTokens: 200_000,
  maxJudgeFailures: 3,
  timeoutMs: 30 * 60_000,
}

function buildGoalInput(overrides: Partial<Goal> = {}): Parameters<typeof createGoal>[0] {
  return {
    id: overrides.id ?? crypto.randomUUID(),
    sessionId: overrides.sessionId ?? "ses_a",
    rawObjective: "x",
    safeObjective: "x",
    redactionMapEnc: "",
    status: overrides.status ?? "active",
    turnsUsed: 0,
    tokensUsed: 0,
    judgeFailureCount: 0,
    config: CONFIG,
    generationId: "gen-1",
    ...overrides,
  }
}

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  getDb()
  await whenSeeded()
})

describe("useOpenGoal", () => {
  it("returns active when present", async () => {
    await createGoal(buildGoalInput({ id: "g_a", status: "active" }))
    const { result } = renderHook(() => useOpenGoal("ses_a"))
    await waitFor(() => expect(result.current?.id).toBe("g_a"))
  })

  it("returns paused when no active", async () => {
    await createGoal(buildGoalInput({ id: "g_p", status: "paused" }))
    const { result } = renderHook(() => useOpenGoal("ses_a"))
    await waitFor(() => expect(result.current?.id).toBe("g_p"))
  })

  it("returns null for terminal-only goals", async () => {
    await createGoal(buildGoalInput({ id: "g_done", status: "completed" }))
    const { result } = renderHook(() => useOpenGoal("ses_a"))
    await waitFor(() => expect(result.current).not.toBeUndefined())
    expect(result.current).toBeNull()
  })
})
