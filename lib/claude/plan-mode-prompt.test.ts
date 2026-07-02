import { PLAN_MODE_PROMPT } from "./plan-mode-prompt"

// Drift tripwire: both surfaces (GUI PLAN_MODE_SNIPPET, CLI
// PLAN_MODE_PROMPT_SECTION) re-export this constant. These contract phrases
// are what the plan-mode UX depends on — renaming a subagent or an exit tool
// must fail here first.
describe("PLAN_MODE_PROMPT contract", () => {
  it("frames the mode as read-only research", () => {
    expect(PLAN_MODE_PROMPT).toContain("Plan mode (READ-ONLY")
    expect(PLAN_MODE_PROMPT).toContain("Do NOT edit files")
  })

  it("names the read-only Explore / Plan subagents", () => {
    expect(PLAN_MODE_PROMPT).toContain("`Explore` subagent")
    expect(PLAN_MODE_PROMPT).toContain("`Plan` subagent")
  })

  it("names BOTH exit-plan tool ids (native + ai-sdk)", () => {
    expect(PLAN_MODE_PROMPT).toContain("ExitPlanMode")
    expect(PLAN_MODE_PROMPT).toContain("exit_plan_mode")
  })

  it("keeps clarifying questions in plain text (no tool call)", () => {
    expect(PLAN_MODE_PROMPT).toContain("ask the user directly in plain text")
    expect(PLAN_MODE_PROMPT).toContain("do not call the plan-submission tool")
  })

  it("re-exports identically on both surfaces", async () => {
    const { PLAN_MODE_SNIPPET } = await import("./build-options")
    expect(PLAN_MODE_SNIPPET).toBe(PLAN_MODE_PROMPT)
  })
})
