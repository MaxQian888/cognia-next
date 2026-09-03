import { planRuntimeConnection } from "./connect-runtime"

const config = (preset?: string) => ({ metadata: preset ? { preset } : {} })

describe("planRuntimeConnection", () => {
  it("resolves each vendor to the preset that would run it", () => {
    expect(planRuntimeConnection({ vendor: "codex", existingConfigs: {} })).toEqual({
      presetId: "codex",
      existingAgentId: null,
    })
    expect(planRuntimeConnection({ vendor: "opencode", existingConfigs: {} })?.presetId).toBe(
      "opencode-server"
    )
  })

  it("resolves Pi, which the map this replaced could not", () => {
    expect(planRuntimeConnection({ vendor: "pi", existingConfigs: {} })?.presetId).toBe("pi-rpc")
  })

  it("points at the existing connection instead of creating a second one", () => {
    // `addAgentFromPreset` creates unconditionally, so without this a user who
    // migrates twice ends up with two identical Codex connections.
    const plan = planRuntimeConnection({
      vendor: "codex",
      existingConfigs: { "agent-1": config("codex"), "agent-2": config("claude-code") },
    })
    expect(plan?.existingAgentId).toBe("agent-1")
  })

  it("ignores a config created from a different preset in the same ecosystem", () => {
    // `codex-app-server` is the same ecosystem but a different surface, and the
    // offer names one specific preset.
    const plan = planRuntimeConnection({
      vendor: "codex",
      existingConfigs: { "agent-1": config("codex-app-server") },
    })
    expect(plan?.existingAgentId).toBeNull()
  })

  it("ignores a hand-configured agent with no preset stamp", () => {
    const plan = planRuntimeConnection({
      vendor: "codex",
      existingConfigs: { "agent-1": config() },
    })
    expect(plan?.existingAgentId).toBeNull()
  })

  it("offers nothing for a vendor with no launchable runtime", () => {
    expect(planRuntimeConnection({ vendor: "aider", existingConfigs: {} })).toBeNull()
    expect(planRuntimeConnection({ vendor: "nope", existingConfigs: {} })).toBeNull()
  })

  it("offers nothing when the migration imported nothing", () => {
    // Every category shared, empty or unsupported. Offering to connect a
    // runtime off the back of that reads as a result the user did not get.
    expect(
      planRuntimeConnection({ vendor: "codex", existingConfigs: {}, importedCounts: [0, 0, 0] })
    ).toBeNull()
  })

  it("offers once anything at all was imported", () => {
    expect(
      planRuntimeConnection({ vendor: "codex", existingConfigs: {}, importedCounts: [0, 2] })
    ).not.toBeNull()
  })

  it("offers when the caller supplies no counts at all", () => {
    expect(planRuntimeConnection({ vendor: "codex", existingConfigs: {} })).not.toBeNull()
  })
})
