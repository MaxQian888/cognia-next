import { PLAN_MODE_PROMPT, PLAN_MODE_STRUCTURED_STEPS_PROMPT } from "./plan-mode"

// Drift tripwire: both surfaces (the GUI assembler and the CLI base) resolve
// this one definition. These contract phrases
// are what the plan-mode UX depends on — renaming a subagent or an exit tool
// must fail here first.
describe("PLAN_MODE_PROMPT contract", () => {
  it("frames the mode as read-only research", () => {
    expect(PLAN_MODE_PROMPT.defaultBody).toContain("Plan mode (READ-ONLY")
    expect(PLAN_MODE_PROMPT.defaultBody).toContain("Do NOT edit files")
  })

  it("names the read-only Explore / Plan subagents", () => {
    expect(PLAN_MODE_PROMPT.defaultBody).toContain("`Explore` subagent")
    expect(PLAN_MODE_PROMPT.defaultBody).toContain("`Plan` subagent")
  })

  it("names BOTH exit-plan tool ids (native + ai-sdk)", () => {
    expect(PLAN_MODE_PROMPT.defaultBody).toContain("ExitPlanMode")
    expect(PLAN_MODE_PROMPT.defaultBody).toContain("exit_plan_mode")
  })

  it("keeps clarifying questions in plain text (no tool call)", () => {
    expect(PLAN_MODE_PROMPT.defaultBody).toContain("ask the user directly in plain text")
    expect(PLAN_MODE_PROMPT.defaultBody).toContain("do not call the plan-submission tool")
  })

  it("keeps both exit-plan tool names as required fragments of any custom version", () => {
    expect(PLAN_MODE_PROMPT.requiredFragments).toEqual(["ExitPlanMode", "exit_plan_mode"])
  })
})

describe("PLAN_MODE_STRUCTURED_STEPS_PROMPT contract", () => {
  it("is additive — the shared base prompt does not embed it", () => {
    expect(PLAN_MODE_PROMPT.defaultBody).not.toContain("## Steps")
  })

  it("asks for the parse-friendly step list the interactive editor projects", () => {
    // `parsePlanText` recognises top-level bullets / numbered items; the
    // snippet must keep steering the model toward exactly that shape.
    expect(PLAN_MODE_STRUCTURED_STEPS_PROMPT.defaultBody).toContain("## Steps")
    expect(PLAN_MODE_STRUCTURED_STEPS_PROMPT.defaultBody).toContain("numbered list")
    expect(PLAN_MODE_STRUCTURED_STEPS_PROMPT.defaultBody).toContain("imperative")
    expect(PLAN_MODE_STRUCTURED_STEPS_PROMPT.defaultBody).toContain("interactive step editor")
  })
})
