import { defineWorkflowTrigger } from "./define-workflow-trigger"

describe("defineWorkflowTrigger", () => {
  it("returns the trigger definition unchanged (pure pass-through)", () => {
    const start = jest.fn(async () => ({ stop: () => {} }))
    const trigger = defineWorkflowTrigger({
      kind: "trigger.poll",
      typeVersion: 1,
      label: "Poll",
      description: "Emit on an interval.",
      iconName: "Timer",
      paramsSchema: { type: "object", properties: { everyMs: { type: "number" } } },
      start,
    })
    expect(trigger.kind).toBe("trigger.poll")
    expect(trigger.start).toBe(start)
  })

  it("preserves optional defaultParams/desktopOnly", () => {
    const trigger = defineWorkflowTrigger({
      kind: "trigger.x",
      typeVersion: 1,
      label: "X",
      description: "x",
      iconName: "Box",
      paramsSchema: {},
      defaultParams: { everyMs: 1000 },
      desktopOnly: true,
      start: async () => ({ stop: () => {} }),
    })
    expect(trigger).toMatchObject({ defaultParams: { everyMs: 1000 }, desktopOnly: true })
  })
})
