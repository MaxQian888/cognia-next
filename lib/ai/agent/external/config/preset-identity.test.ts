import { externalAgentPresetIdOf, isDevinAgentConfig } from "./preset-identity"

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

describe("isDevinAgentConfig", () => {
  it("recognises the preset and a hand-pointed devin binary", () => {
    expect(isDevinAgentConfig({ metadata: { preset: "devin" } })).toBe(true)
    expect(isDevinAgentConfig({ process: { command: "devin" } })).toBe(true)
    expect(isDevinAgentConfig({ process: { command: "/opt/homebrew/bin/devin" } })).toBe(true)
    expect(isDevinAgentConfig({ process: { command: "C:\\tools\\devin.exe" } })).toBe(true)
  })

  it("does not confuse other agents or devin-suffixed binaries for Devin", () => {
    expect(isDevinAgentConfig({ metadata: { preset: "codex" } })).toBe(false)
    expect(isDevinAgentConfig({ process: { command: "devin-cli" } })).toBe(false)
    expect(isDevinAgentConfig({ process: { command: "/usr/bin/not-devin" } })).toBe(false)
    expect(isDevinAgentConfig({})).toBe(false)
    expect(isDevinAgentConfig(undefined)).toBe(false)
  })
})
