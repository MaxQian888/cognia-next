import { ADHERENCE_TOOL, GOVERNANCE_SKILL, REPORT_TOOL } from "./skill"

describe("GOVERNANCE_SKILL", () => {
  it("is an inline global playbook gated to the two read-only tools", () => {
    expect(GOVERNANCE_SKILL.id).toBe("cognia-config-governance:config-governance")
    expect(GOVERNANCE_SKILL.scope).toBe("global")
    expect(GOVERNANCE_SKILL.allowedTools).toEqual([REPORT_TOOL, ADHERENCE_TOOL])
    expect(GOVERNANCE_SKILL.source.kind).toBe("inline")
  })

  it("tells the model it cannot apply changes", () => {
    const markdown =
      GOVERNANCE_SKILL.source.kind === "inline" ? GOVERNANCE_SKILL.source.markdown : ""
    expect(markdown).toContain(REPORT_TOOL)
    expect(markdown).toContain(ADHERENCE_TOOL)
    expect(markdown).toMatch(/cannot apply changes/)
  })
})
