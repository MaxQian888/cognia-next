import { validatePlanStepParams } from "./step-params"

describe("validatePlanStepParams", () => {
  it("treats agent_turn / approval_gate prompts as optional", () => {
    expect(validatePlanStepParams("agent_turn", undefined)).toEqual({ params: undefined })
    expect(validatePlanStepParams("agent_turn", { prompt: "  go  " })).toEqual({
      params: { kind: "agent_turn", prompt: "go" },
    })
    expect(validatePlanStepParams("approval_gate", {})).toEqual({ params: undefined })
    expect(validatePlanStepParams("approval_gate", { prompt: "ok?" })).toEqual({
      params: { kind: "approval_gate", prompt: "ok?" },
    })
  })

  it("requires a team for delegation but not a teammate", () => {
    expect(validatePlanStepParams("teammate_dispatch", {})).toEqual({ error: "missing" })
    expect(validatePlanStepParams("teammate_dispatch", { teamId: "t1" })).toEqual({
      params: { kind: "teammate_dispatch", teamId: "t1" },
    })
    expect(
      validatePlanStepParams("teammate_dispatch", {
        teamId: "t1",
        teammateId: "m1",
        spawnPrompt: "do it",
      })
    ).toEqual({
      params: { kind: "teammate_dispatch", teamId: "t1", teammateId: "m1", spawnPrompt: "do it" },
    })
  })

  it("requires the ids the dispatcher dereferences", () => {
    expect(validatePlanStepParams("sub_workflow", {})).toEqual({ error: "missing" })
    expect(validatePlanStepParams("tool_call", {})).toEqual({ error: "missing" })
    expect(validatePlanStepParams("mcp_tool_call", { serverId: "s" })).toEqual({ error: "missing" })
    expect(validatePlanStepParams("mcp_tool_call", { toolName: "t" })).toEqual({ error: "missing" })
  })

  it("defaults tool input to an empty object and ignores non-objects", () => {
    expect(validatePlanStepParams("tool_call", { toolName: "fs.read" })).toEqual({
      params: { kind: "tool_call", toolName: "fs.read", input: {} },
    })
    expect(validatePlanStepParams("tool_call", { toolName: "fs.read", input: [1, 2] })).toEqual({
      params: { kind: "tool_call", toolName: "fs.read", input: {} },
    })
  })

  // A model can emit any key it likes; only the contract's fields may persist.
  it("drops unknown keys instead of persisting them", () => {
    expect(validatePlanStepParams("sub_workflow", { workflowId: "wf", evil: "x" })).toEqual({
      params: { kind: "sub_workflow", workflowId: "wf" },
    })
  })
})
