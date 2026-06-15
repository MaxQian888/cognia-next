import {
  replanDecisionSchema,
  replanNewTaskSchema,
  continueDecision,
  REPLAN_SCHEMA_HINT,
} from "./replan-schema"

describe("replan-schema", () => {
  it("parses a minimal continue decision and defaults the arrays", () => {
    const parsed = replanDecisionSchema.parse({ action: "continue", reasoning: "ok" })
    expect(parsed.newTasks).toEqual([])
    expect(parsed.cancelTaskIds).toEqual([])
    expect(parsed.reorderTaskIds).toEqual([])
  })

  it("parses an inject decision with new tasks", () => {
    const parsed = replanDecisionSchema.parse({
      action: "inject",
      reasoning: "need a verifier",
      newTasks: [{ title: "Verify", description: "double-check", dependsOn: ["task-1"] }],
    })
    expect(parsed.newTasks).toHaveLength(1)
    expect(parsed.newTasks[0]!.dependsOn).toEqual(["task-1"])
  })

  it("rejects an unknown action", () => {
    expect(replanDecisionSchema.safeParse({ action: "explode", reasoning: "x" }).success).toBe(
      false
    )
  })

  it("rejects an empty reasoning", () => {
    expect(replanDecisionSchema.safeParse({ action: "finish", reasoning: "" }).success).toBe(false)
  })

  it("new-task schema defaults dependsOn to empty", () => {
    const t = replanNewTaskSchema.parse({ title: "T", description: "D" })
    expect(t.dependsOn).toEqual([])
  })

  it("continueDecision builds a valid passthrough decision", () => {
    const d = continueDecision("steady")
    expect(replanDecisionSchema.parse(d)).toEqual(d)
    expect(d.action).toBe("continue")
    expect(d.reasoning).toBe("steady")
  })

  it("exposes a schema hint mentioning every action", () => {
    for (const a of ["continue", "inject", "cancel", "reorder", "finish"]) {
      expect(REPLAN_SCHEMA_HINT).toContain(a)
    }
  })
})
