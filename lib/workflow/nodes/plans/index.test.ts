import "."
import { getExecutor } from "../registry"

describe("plan-nodes registration", () => {
  it.each([
    ["action.plan.approve", 1],
    ["action.plan.cancel", 1],
    ["action.plan.create", 1],
    ["action.plan.delete", 1],
    ["action.plan.events", 1],
    ["action.plan.get", 1],
    ["action.plan.list", 1],
    ["action.plan.pause", 1],
    ["action.plan.refine", 1],
    ["action.plan.reject", 1],
    ["action.plan.resume", 1],
    ["action.plan.run", 1],
    ["action.plan.setStepStatus", 1],
    ["action.plan.step.dispatch", 1],
    ["action.plan.updateDraft", 1],
  ])("registers %s@%s", (kind, version) => {
    expect(getExecutor(kind as never, version)).toBeDefined()
  })
})
