import { clampSubagentTools, harnessSubagentDefinitions, renderHarnessSections } from "./render"

describe("renderHarnessSections", () => {
  it("renders the non-empty sections in a fixed order", () => {
    expect(
      renderHarnessSections({ toolGuidance: " Use Read. ", guardrails: "Never guess.", memory: "" })
    ).toBe("## Standing rules\n\nNever guess.\n\n## Tool guidance\n\nUse Read.")
  })

  it("renders nothing for an empty or absent harness", () => {
    expect(renderHarnessSections(undefined)).toBe("")
    expect(renderHarnessSections({ guardrails: "  ", subagents: [] })).toBe("")
  })
})

describe("clampSubagentTools", () => {
  const def = { description: "d", prompt: "p", tools: ["Read", "Bash", "WebFetch"] }

  it("keeps only tools the parent allows and carries the parent's denials", () => {
    expect(clampSubagentTools(def, ["Read", "Bash"], ["Bash"])).toEqual({
      description: "d",
      prompt: "p",
      tools: ["Read"],
      disallowedTools: ["Bash"],
    })
  })

  it("inherits the parent's allow list when the subagent declared none", () => {
    expect(
      clampSubagentTools({ description: "d", prompt: "p" }, ["Read"], undefined).tools
    ).toEqual(["Read"])
  })

  it("leaves tools alone when the parent has no allow list, still applying denials", () => {
    expect(clampSubagentTools(def, undefined, ["WebFetch"])).toEqual({
      ...def,
      tools: ["Read", "Bash"],
      disallowedTools: ["WebFetch"],
    })
    expect(clampSubagentTools({ description: "d", prompt: "p" }, undefined, undefined)).toEqual({
      description: "d",
      prompt: "p",
    })
  })
})

describe("harnessSubagentDefinitions", () => {
  it("keys complete definitions by name and drops incomplete ones", () => {
    expect(
      harnessSubagentDefinitions({
        subagents: [
          { name: "checker", description: " Checks. ", prompt: " Check it. ", tools: ["Read"] },
          { name: "empty", description: "", prompt: "x" },
        ],
      })
    ).toEqual({ checker: { description: "Checks.", prompt: "Check it.", tools: ["Read"] } })
    expect(harnessSubagentDefinitions(null)).toEqual({})
  })
})
