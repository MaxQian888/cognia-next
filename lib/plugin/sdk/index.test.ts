import * as sdk from "./index"

describe("lib/plugin/sdk barrel", () => {
  it.each([
    "defineMcpServerPreset",
    "defineNativeAnthropicTool",
    "defineSkill",
    "defineSubagent",
    "defineAgentTeamTemplate",
  ])("exports %s as a passthrough function", (name) => {
    const sym = (sdk as Record<string, unknown>)[name]
    expect(typeof sym).toBe("function")
    // Each defineXxx is a typed identity — invoking with an arbitrary
    // shape should return it unchanged (no runtime validation).
    const probe = { id: "x", label: "X" }
    const result = (sym as (input: unknown) => unknown)(probe)
    expect(result).toBe(probe)
  })

  // These two narrow + lightly validate (not pure identity), so just assert
  // the barrel re-exports them (they were authored but previously unexported).
  it.each(["defineCharacterPack", "defineWorkflowTemplate"])("re-exports %s", (name) => {
    expect(typeof (sdk as Record<string, unknown>)[name]).toBe("function")
  })
})
