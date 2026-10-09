import "fake-indexeddb/auto"

import { getDb } from "@/lib/db/schema"
import { createDbTestFixture } from "@/lib/db/test-fixture"
import { __resetGoalRuntimeForTesting, getGoalRuntime } from "@/lib/goal/runtime"
import { __resetRedactionKey } from "@/lib/twin/ingest/redaction-key"

let llmClient: { complete: jest.Mock } | null = null
jest.mock("@/lib/ai/renderer-llm-client", () => ({
  buildRendererLlmClient: jest.fn(() => llmClient),
}))

import { buildRendererLlmClient } from "@/lib/ai/renderer-llm-client"
import { generateGoalSubgoals } from "./subgoal-generation"

const buildClientMock = buildRendererLlmClient as jest.Mock
const dbFixture = createDbTestFixture()

beforeAll(dbFixture.initialize)
beforeEach(async () => {
  await dbFixture.restore()
  await __resetRedactionKey()
  __resetGoalRuntimeForTesting()
  llmClient = { complete: jest.fn() }
  buildClientMock.mockClear()
})
afterAll(dbFixture.dispose)

async function makeGoal() {
  const goal = await getGoalRuntime().createGoal({
    sessionId: "ses_a",
    rawObjective: "ship the feature",
  })
  return goal.id
}

describe("generateGoalSubgoals", () => {
  it("writes a checklist and answers generated", async () => {
    const goalId = await makeGoal()
    llmClient!.complete.mockResolvedValue('{"steps": ["Plan", "Build"]}')
    const settings = { id: "settings" } as never
    const result = await generateGoalSubgoals(goalId, settings)
    expect(result.outcome).toBe("generated")
    expect(result.goal?.subgoals?.map((s) => s.text)).toEqual(["Plan", "Build"])
    expect(buildClientMock).toHaveBeenCalledWith(
      expect.objectContaining({ appSettings: settings, featureId: "goal-subgoals" })
    )
  })

  it("answers empty and keeps the prior checklist when the model gives nothing usable", async () => {
    const goalId = await makeGoal()
    llmClient!.complete.mockResolvedValueOnce('{"steps": ["Plan"]}')
    await generateGoalSubgoals(goalId, null)
    llmClient!.complete.mockResolvedValueOnce("not json")
    const result = await generateGoalSubgoals(goalId, null)
    expect(result.outcome).toBe("empty")
    expect(result.goal?.subgoals?.map((s) => s.text)).toEqual(["Plan"])
  })

  it("answers unavailable without a resolvable model, and never calls one", async () => {
    const goalId = await makeGoal()
    llmClient = null
    const result = await generateGoalSubgoals(goalId, null)
    expect(result).toEqual({
      outcome: "unavailable",
      goal: expect.objectContaining({ id: goalId }),
    })
    expect((await getDb().chatGoals.get(goalId))?.subgoals ?? []).toHaveLength(0)
  })

  it("answers missing for a goal that does not exist", async () => {
    expect(await generateGoalSubgoals("nope", null)).toEqual({ outcome: "missing", goal: null })
    expect(buildClientMock).not.toHaveBeenCalled()
  })
})
