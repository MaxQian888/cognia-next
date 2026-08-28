import definition, { getGoalInsights, __resetGoalInsightsForTesting } from "./index"
import manifest from "../plugin.json"
import type { GoalHookPayload, PluginHooksAll } from "@cognia/plugin-sdk"
const payload = (over: Partial<GoalHookPayload> = {}): GoalHookPayload => ({
  goalId: "g1",
  sessionId: "s1",
  status: "active",
  safeObjective: "ship the thing",
  turnsUsed: 0,
  tokensUsed: 0,
  ...over,
})

beforeEach(() => {
  __resetGoalInsightsForTesting()
})

describe("cognia-goal-insights", () => {
  it("declares the hooks capability and returns hooks from activate()", async () => {
    expect(manifest.id).toBe("cognia-goal-insights")
    expect(manifest.capabilities).toContain("hooks")
    const ctx = { pluginId: manifest.id, logger: { info: jest.fn() } } as never
    const hooks = (await definition.activate?.(ctx)) as PluginHooksAll
    expect(hooks?.onGoalComplete).toBeInstanceOf(Function)
  })

  it("records a redacted snapshot on goal create + complete", async () => {
    const ctx = { pluginId: manifest.id, logger: { info: jest.fn() } } as never
    const hooks = (await definition.activate?.(ctx)) as PluginHooksAll
    await hooks.onGoalCreate?.(payload({ goalId: "g1" }))
    await hooks.onGoalComplete?.(payload({ goalId: "g1", status: "completed", turnsUsed: 4 }))

    const log = getGoalInsights()
    expect(log).toHaveLength(2)
    expect(log[0]).toMatchObject({ kind: "created", goalId: "g1" })
    expect(log[1]).toMatchObject({ kind: "completed", goalId: "g1", turnsUsed: 4 })
    // Only the redacted objective is ever recorded.
    expect(log[1].safeObjective).toBe("ship the thing")
  })

  it("activate returns hooks and deactivate is no-throw with a minimal context", async () => {
    const ctx = { pluginId: manifest.id, logger: { info: jest.fn() } } as never
    await expect(definition.activate?.(ctx)).resolves.toBeDefined()
    await expect(definition.deactivate?.(ctx)).resolves.toBeUndefined()
  })
})
