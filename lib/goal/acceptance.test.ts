/** @jest-environment jsdom */
import "fake-indexeddb/auto"
import { createGoal, getGoal, listGoalEvents, updateGoal } from "@/lib/db/goals"
import { __resetDbForTesting, getDb, whenSeeded } from "@/lib/db/schema"
import type { Goal, GoalConfig } from "@/types/goal"

const onGoalTerminalMock = jest.fn().mockResolvedValue(undefined)
jest.mock("./completion-linkage", () => ({
  onGoalTerminal: (...a: unknown[]) => onGoalTerminalMock(...a),
  toGoalHookPayload: (g: unknown) => g,
}))

import { resolveGoalAcceptance } from "./acceptance"

const CONFIG: GoalConfig = {
  maxTurns: 20,
  maxTokens: 200_000,
  maxJudgeFailures: 3,
  timeoutMs: 30 * 60_000,
  requireAcceptance: true,
}

function buildGoal(overrides: Partial<Goal> = {}): Parameters<typeof createGoal>[0] {
  return {
    id: overrides.id ?? "g1",
    sessionId: "ses_a",
    rawObjective: "objective",
    safeObjective: "objective",
    redactionMapEnc: "",
    status: overrides.status ?? "paused",
    turnsUsed: 3,
    tokensUsed: 0,
    judgeFailureCount: 0,
    config: CONFIG,
    generationId: overrides.generationId ?? "gen-1",
  }
}

async function seedAwaiting(id = "g1"): Promise<void> {
  await createGoal(buildGoal({ id }))
  await updateGoal(id, { status: "paused", awaitingAcceptance: true })
}

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  getDb()
  await whenSeeded()
  onGoalTerminalMock.mockClear()
})

describe("resolveGoalAcceptance", () => {
  it("accept commits completed, clears the flag, rotates generationId, fires linkage", async () => {
    await seedAwaiting()
    const before = await getGoal("g1")
    const updated = await resolveGoalAcceptance("g1", true)
    expect(updated?.status).toBe("completed")
    expect(updated?.awaitingAcceptance).toBe(false)
    expect(updated?.generationId).not.toBe(before?.generationId)
    expect(updated?.endedAt).toBeDefined()
    expect(onGoalTerminalMock).toHaveBeenCalledTimes(1)
    const events = await listGoalEvents("g1", 50)
    const resolved = events.find((e) => e.kind === "acceptance_resolved")
    expect(resolved?.payload).toMatchObject({ kind: "acceptance_resolved", accepted: true })
  })

  it("request-changes resumes active without firing linkage", async () => {
    await seedAwaiting()
    const updated = await resolveGoalAcceptance("g1", false)
    expect(updated?.status).toBe("active")
    expect(updated?.awaitingAcceptance).toBe(false)
    expect(onGoalTerminalMock).not.toHaveBeenCalled()
    const events = await listGoalEvents("g1", 50)
    expect(events.some((e) => e.kind === "acceptance_resolved")).toBe(true)
  })

  it("is a no-op for goals not awaiting acceptance", async () => {
    await createGoal(buildGoal({ id: "g2", status: "active" }))
    const out = await resolveGoalAcceptance("g2", true)
    expect(out?.status).toBe("active")
    expect(onGoalTerminalMock).not.toHaveBeenCalled()
    const events = await listGoalEvents("g2", 50)
    expect(events.some((e) => e.kind === "acceptance_resolved")).toBe(false)
  })

  it("returns null for a missing goal", async () => {
    expect(await resolveGoalAcceptance("missing", true)).toBeNull()
  })
})
