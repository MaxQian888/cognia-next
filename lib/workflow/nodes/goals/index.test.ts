import "."
import { getExecutor } from "../registry"

describe("goal-nodes registration", () => {
  it.each([
    ["action.goal.analytics", 1],
    ["action.goal.clearSubgoals", 1],
    ["action.goal.create", 1],
    ["action.goal.decomposeSubgoals", 1],
    ["action.goal.delete", 1],
    ["action.goal.events", 1],
    ["action.goal.get", 1],
    ["action.goal.list", 1],
    ["action.goal.pause", 1],
    ["action.goal.preempt", 1],
    ["action.goal.resume", 1],
    ["action.goal.stop", 1],
    ["action.goal.template.createGoal", 1],
    ["action.goal.template.delete", 1],
    ["action.goal.template.favorite", 1],
    ["action.goal.template.list", 1],
    ["action.goal.template.upsert", 1],
    ["action.goal.toggleSubgoal", 1],
    ["action.goal.updateConfig", 1],
    ["action.goal.updateObjective", 1],
  ])("registers %s@%s", (kind, version) => {
    expect(getExecutor(kind as never, version)).toBeDefined()
  })
})
