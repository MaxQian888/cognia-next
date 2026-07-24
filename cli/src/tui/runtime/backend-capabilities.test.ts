/**
 * @jest-environment node
 */
import {
  BACKEND_FEATURES,
  blockedFeatures,
  builtinCapabilities,
  externalCapabilities,
  featureBlockedReason,
  supportsFeature,
  unsupportedFeatureMessage,
  usesCodexOptions,
} from "./backend-capabilities"

describe("builtinCapabilities", () => {
  it("supports every feature, since the sidecar is what they were built against", () => {
    const caps = builtinCapabilities()
    expect(caps.builtin).toBe(true)
    for (const feature of BACKEND_FEATURES) {
      expect(supportsFeature(caps, feature)).toBe(true)
      expect(featureBlockedReason(caps, feature)).toBeUndefined()
    }
    expect(blockedFeatures(caps)).toEqual([])
  })
})

describe("externalCapabilities", () => {
  it("gives every blocked feature a reason", () => {
    const caps = externalCapabilities({ backend: "claude-code" })
    expect(caps.builtin).toBe(false)
    for (const feature of blockedFeatures(caps)) {
      // A blocked feature without a reason is the silent failure this exists to stop.
      expect(featureBlockedReason(caps, feature)).toBeTruthy()
      expect(supportsFeature(caps, feature)).toBe(false)
    }
  })

  it("supports MCP everywhere, since both protocols carry it on session/new", () => {
    for (const backend of ["claude-code", "codex"]) {
      expect(supportsFeature(externalCapabilities({ backend }), "mcp")).toBe(true)
    }
  })

  it("supports the Codex-only channels on Codex and explains their absence elsewhere", () => {
    const codex = externalCapabilities({ backend: "codex", presetId: "codex-app-server" })
    const acp = externalCapabilities({ backend: "claude-code" })

    // Reasoning effort + extra skill roots ride Codex's metadata channel; ACP
    // has no counterpart, so claiming either there would be a lie.
    expect(supportsFeature(codex, "thinking")).toBe(true)
    expect(supportsFeature(codex, "skills")).toBe(true)
    expect(featureBlockedReason(acp, "thinking")).toMatch(/no equivalent/)
    expect(featureBlockedReason(acp, "skills")).toMatch(/no equivalent/)
  })

  it("reads session resume off what the agent negotiated", () => {
    expect(
      supportsFeature(
        externalCapabilities({ backend: "claude-code", negotiated: { multiTurn: true } }),
        "resume"
      )
    ).toBe(true)
    expect(
      featureBlockedReason(externalCapabilities({ backend: "claude-code" }), "resume")
    ).toMatch(/no equivalent/)
  })

  it("recognises both Codex preset spellings as the metadata channel", () => {
    // One definition, shared with the bridge that does the forwarding, so the
    // advertised capability cannot drift from what is actually sent.
    expect(usesCodexOptions("codex")).toBe(true)
    expect(usesCodexOptions("codex-app-server")).toBe(true)
    expect(usesCodexOptions("claude-code")).toBe(false)
    expect(usesCodexOptions(undefined)).toBe(false)
  })

  it("still blocks everything the sidecar alone can do", () => {
    const caps = externalCapabilities({ backend: "codex", presetId: "codex-app-server" })
    expect(blockedFeatures(caps)).toEqual([
      "plugins",
      "compact",
      "resume",
      "rateLimits",
      "mcpLogs",
      "hooks",
      "subagentModels",
    ])
  })

  it("attributes MCP logs to the agent that owns the servers", () => {
    expect(featureBlockedReason(externalCapabilities({ backend: "codex" }), "mcpLogs")).toMatch(
      /runs these itself/
    )
  })
})

describe("supportsFeature", () => {
  it("defaults to supported when no capability set has been resolved", () => {
    // Guards the built-in path: a missing set must never disable the TUI.
    expect(supportsFeature(undefined, "compact")).toBe(true)
    expect(featureBlockedReason(undefined, "compact")).toBeUndefined()
    expect(blockedFeatures(undefined)).toEqual([])
  })
})

describe("unsupportedFeatureMessage", () => {
  it("names the feature, the backend and the reason", () => {
    const message = unsupportedFeatureMessage(externalCapabilities({ backend: "codex" }), "compact")
    expect(message).toContain("Context compaction")
    expect(message).toContain("codex")
    expect(message).toContain("no equivalent")
  })

  it("degrades to a bare statement when there is no capability set", () => {
    expect(unsupportedFeatureMessage(undefined, "mcp")).toBe("MCP servers is unavailable.")
  })
})
