import type { GoalHookPayload, PluginContext, PluginHooksAll } from "@cognia/plugin-sdk"

import definition, {
  createGoalInsightHooks,
  GOAL_INSIGHTS_EXAMPLE,
  manifest,
  OBJECTIVE_EXCERPT_LIMIT,
} from "./index"
import manifestJson from "../plugin.json"

const payload = (over: Partial<GoalHookPayload> = {}): GoalHookPayload => ({
  goalId: "g1",
  sessionId: "s1",
  status: "active",
  safeObjective: "ship the thing",
  turnsUsed: 0,
  tokensUsed: 0,
  ...over,
})

function makeCtx() {
  const info = jest.fn()
  const ctx = { pluginId: manifestJson.id, logger: { info } } as unknown as PluginContext
  return { ctx, info }
}

describe("cognia-goal-insights (example)", () => {
  it("returns goal hooks from activate()", async () => {
    const { ctx } = makeCtx()
    const hooks = (await definition.activate?.(ctx)) as PluginHooksAll
    expect(hooks.onGoalCreate).toBeInstanceOf(Function)
    expect(hooks.onGoalComplete).toBeInstanceOf(Function)
  })

  it("writes one redacted line per lifecycle event to the plugin log", async () => {
    const { ctx, info } = makeCtx()
    const hooks = createGoalInsightHooks(ctx.logger)
    await hooks.onGoalCreate?.(payload({ goalId: "g1" }))
    await hooks.onGoalComplete?.(payload({ goalId: "g1", status: "completed", turnsUsed: 4 }))

    expect(info).toHaveBeenCalledTimes(2)
    expect(info.mock.calls[0][0]).toContain("goal created: g1")
    expect(info.mock.calls[1][0]).toContain("goal completed: g1 status=completed turns=4")
    expect(info.mock.calls[1][0]).toContain('objective="ship the thing"')
  })

  it("bounds the objective excerpt it logs", async () => {
    const { ctx, info } = makeCtx()
    const hooks = createGoalInsightHooks(ctx.logger)
    await hooks.onGoalCreate?.(payload({ safeObjective: "x".repeat(OBJECTIVE_EXCERPT_LIMIT * 3) }))
    const logged = /objective="([^"]*)"/.exec(info.mock.calls[0][0] as string)?.[1] ?? ""
    expect(logged.length).toBe(OBJECTIVE_EXCERPT_LIMIT)
    expect(logged.endsWith("…")).toBe(true)
  })

  // Rule 7: an example is documented at the const, labelled in the UI, and
  // pinned here — all three must change together.
  it("is labelled and gated as an opt-in example with no UI surface", () => {
    expect(GOAL_INSIGHTS_EXAMPLE).toEqual({ example: true, surface: "plugin-log" })
    expect(manifestJson).not.toHaveProperty("activationEvents")
    expect(manifest.activationEvents ?? []).not.toContain("startup")
    expect(manifestJson.name).toContain("(example)")
    expect(manifestJson.description).toMatch(/adds no UI/)
    expect(manifest.extensions ?? []).toEqual([])
  })
})
