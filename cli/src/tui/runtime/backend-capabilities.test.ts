/**
 * @jest-environment node
 */
import {
  canHostCogniaTools,
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

  it("keeps reasoning effort on the Codex metadata channel only", () => {
    const codex = externalCapabilities({ backend: "codex", presetId: "codex-app-server" })
    const acp = externalCapabilities({ backend: "claude-code" })

    // Reasoning effort rides Codex's metadata channel; ACP has no counterpart,
    // so claiming it there would be a lie.
    expect(supportsFeature(codex, "thinking")).toBe(true)
    expect(featureBlockedReason(acp, "thinking")).toMatch(/no equivalent/)
  })

  it("reports skills on every backend that can host the Cognia bridge", () => {
    // Skills used to be Codex-only, back when the only channel was Codex's own
    // skill-root scan. They now ride the canonical system prompt (catalog +
    // `load_skill`), which every external backend receives.
    expect(supportsFeature(externalCapabilities({ backend: "claude-code" }), "skills")).toBe(true)
    expect(
      featureBlockedReason(
        externalCapabilities({ backend: "claude-code", negotiated: { mcpTools: false } }),
        "skills"
      )
    ).toMatch(/tool bridge/)
  })

  it("offers model selection only where the agent can enumerate its own models", () => {
    // `model/list` is native-app-server only. The `codex` preset is the ACP
    // shim, and ACP has no model-list call — a picker there could only show the
    // built-in provider's catalog, which is not what that agent runs.
    const native = externalCapabilities({ backend: "codex", presetId: "codex-app-server" })
    const shim = externalCapabilities({ backend: "codex", presetId: "codex" })
    const acp = externalCapabilities({ backend: "claude-code" })

    expect(supportsFeature(native, "modelPicker")).toBe(true)
    expect(featureBlockedReason(shim, "modelPicker")).toMatch(/no equivalent/)
    expect(featureBlockedReason(acp, "modelPicker")).toMatch(/no equivalent/)
    // Narrower than the metadata channel on purpose — the shim still forwards
    // reasoning effort, it just cannot list models.
    expect(supportsFeature(shim, "thinking")).toBe(true)
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

describe("canHostCogniaTools", () => {
  it("treats an omitted capability as a present protocol slot", () => {
    expect(canHostCogniaTools(undefined)).toBe(true)
    expect(canHostCogniaTools({})).toBe(true)
  })

  it("treats an explicit refusal as incompatible", () => {
    expect(canHostCogniaTools({ mcpTools: false })).toBe(false)
  })
})

describe("externalCapabilities — Cognia tool projection", () => {
  const host = {
    attachable: true,
    running: true,
    builtinToolCount: 12,
    hostToolCount: 3,
    subagentDispatch: true,
  }

  it("reports plugins as supported once the bridge really projected some", () => {
    const caps = externalCapabilities({ backend: "claude-code", toolHost: host })
    expect(supportsFeature(caps, "plugins")).toBe(true)
    expect(supportsFeature(caps, "subagentModels")).toBe(true)
  })

  it("says the policy resolved nothing rather than claiming support", () => {
    const caps = externalCapabilities({
      backend: "claude-code",
      toolHost: { ...host, hostToolCount: 0, subagentDispatch: false },
    })
    expect(featureBlockedReason(caps, "plugins")).toMatch(/resolved no tools/)
  })

  it("blames the bridge when the host could not start", () => {
    const caps = externalCapabilities({
      backend: "claude-code",
      toolHost: { ...host, running: false },
    })
    expect(featureBlockedReason(caps, "plugins")).toMatch(/tool bridge/)
    expect(featureBlockedReason(caps, "subagentModels")).toMatch(/tool bridge/)
  })

  it("blames the protocol when it cannot carry an MCP server at all", () => {
    const caps = externalCapabilities({
      backend: "claude-code",
      toolHost: { ...host, attachable: false },
    })
    expect(featureBlockedReason(caps, "plugins")).toMatch(/tool bridge/)
    expect(featureBlockedReason(caps, "skills")).toMatch(/tool bridge/)
  })
})
