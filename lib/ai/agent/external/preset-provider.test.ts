import { providerIdForPreset } from "./preset-provider"

describe("providerIdForPreset", () => {
  it("maps both codex surfaces to the codex provider", () => {
    expect(providerIdForPreset("codex")).toBe("codex")
    expect(providerIdForPreset("codex-app-server")).toBe("codex")
  })

  it("maps claude-code to anthropic", () => {
    expect(providerIdForPreset("claude-code")).toBe("anthropic")
  })

  it("maps both opencode surfaces to opencode", () => {
    expect(providerIdForPreset("opencode-server")).toBe("opencode")
    expect(providerIdForPreset("opencode-remote")).toBe("opencode")
  })

  it("returns null for presets with no subscription provider", () => {
    expect(providerIdForPreset("gemini-cli")).toBeNull()
    expect(providerIdForPreset("cursor-cli")).toBeNull()
    expect(providerIdForPreset("custom")).toBeNull()
    expect(providerIdForPreset(null)).toBeNull()
    expect(providerIdForPreset(undefined)).toBeNull()
  })
})
