import { buildProjectCoordinatorToolRuleset } from "./project-coordinator-tool-rules"

describe("buildProjectCoordinatorToolRuleset", () => {
  it("allows coordination, asks before changing the limits, on both name forms", () => {
    const rules = buildProjectCoordinatorToolRuleset()
    expect(rules.spawn_thread).toBe("allow")
    expect(rules["mcp__cognia-plugin-tools__spawn_thread"]).toBe("allow")
    expect(rules.report_to_coordinator).toBe("allow")
    expect(rules.set_project_preference).toBe("ask")
    expect(rules["mcp__cognia-plugin-tools__set_project_preference"]).toBe("ask")
  })
})
