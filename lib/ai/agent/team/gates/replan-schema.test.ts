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

  it("accepts the recruit action and defaults newMembers to empty", () => {
    const parsed = replanDecisionSchema.parse({
      action: "recruit",
      reasoning: "need domain expert",
    })
    expect(parsed.action).toBe("recruit")
    expect(parsed.newMembers).toEqual([])
  })

  it("parses a recruit decision with digital-employee members", () => {
    const parsed = replanDecisionSchema.parse({
      action: "recruit",
      reasoning: "bring in security",
      newMembers: [
        { name: "Sec", twinId: "tw1", specialization: "security", description: "sec lead" },
        { name: "Plain" },
      ],
    })
    expect(parsed.newMembers).toHaveLength(2)
    expect(parsed.newMembers[0]).toMatchObject({ name: "Sec", twinId: "tw1" })
    expect(parsed.newMembers[1]!.twinId).toBeUndefined()
  })

  it("continueDecision includes an empty newMembers array", () => {
    expect(continueDecision().newMembers).toEqual([])
  })

  it("schema hint mentions recruit and newMembers", () => {
    expect(REPLAN_SCHEMA_HINT).toContain("recruit")
    expect(REPLAN_SCHEMA_HINT).toContain("newMembers")
  })
})
