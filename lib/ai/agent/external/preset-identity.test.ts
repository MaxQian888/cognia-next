import { externalAgentPresetIdOf } from "./preset-identity"

describe("externalAgentPresetIdOf", () => {
  it("reads the preset id `createConfigFromPreset` stamps", () => {
    expect(externalAgentPresetIdOf({ metadata: { preset: "claude-code" } })).toBe("claude-code")
  })

  it("treats a hand-configured agent as having no preset", () => {
    expect(externalAgentPresetIdOf({ metadata: {} })).toBeUndefined()
    expect(externalAgentPresetIdOf({})).toBeUndefined()
    expect(externalAgentPresetIdOf(undefined)).toBeUndefined()
  })

  it("refuses a non-string or empty value rather than passing it on", () => {
    // `metadata` is `Record<string, unknown>`, so a config written by an older
    // build (or hand-edited) can hold anything here. Returning it unchecked
    // would put a number into a preset-id lookup.
    expect(externalAgentPresetIdOf({ metadata: { preset: 7 } })).toBeUndefined()
    expect(externalAgentPresetIdOf({ metadata: { preset: "" } })).toBeUndefined()
    expect(externalAgentPresetIdOf({ metadata: { preset: null } })).toBeUndefined()
  })
})
