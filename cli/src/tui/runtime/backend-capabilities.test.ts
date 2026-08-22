/**
 * @jest-environment node
 */
import {
  canHostCogniaTools,
  BACKEND_FEATURES,
  blockedFeatures,
  builtinCapabilities,
  effectivePermissionMode,
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

  /**
   * Pi is the first non-Codex backend with a real thinking control and a
   * first-class `compact` command, so these three would otherwise read as
   * unsupported and hide working features behind a "no protocol slot" reason.
   */
  it("reports Pi's native thinking, compaction and model selection", () => {
    const pi = externalCapabilities({ backend: "pi-rpc", presetId: "pi-rpc", protocol: "pi-rpc" })
    expect(supportsFeature(pi, "thinking")).toBe(true)
    expect(supportsFeature(pi, "compact")).toBe(true)
    expect(supportsFeature(pi, "modelPicker")).toBe(true)
  })

  it("keeps compaction unsupported on backends that have no such command", () => {
    // Guards against the Pi carve-out leaking into every protocol.
    const acp = externalCapabilities({ backend: "claude-code", protocol: "acp" })
    expect(supportsFeature(acp, "compact")).toBe(false)
    expect(supportsFeature(acp, "thinking")).toBe(false)
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

  it("offers model selection through either route the protocol provides", () => {
    // Two different routes to the same affordance: the native app-server
    // enumerates models without a session (`model/list`), while ACP exposes a
    // per-session selector (`session/set_model`). The old table only knew the
    // first, so it blocked the picker on the Codex ACP shim — and answered
    // "the agent protocol has no equivalent" about a protocol that has one.
    const native = externalCapabilities({ backend: "codex", presetId: "codex-app-server" })
    const shim = externalCapabilities({ backend: "codex", presetId: "codex" })
    const acp = externalCapabilities({ backend: "claude-code", protocol: "acp" })

    expect(supportsFeature(native, "modelPicker")).toBe(true)
    expect(supportsFeature(shim, "modelPicker")).toBe(true)
    expect(supportsFeature(acp, "modelPicker")).toBe(true)
    // The shim speaks ACP, which has no reasoning-effort control — only the
    // native app-server's Codex options channel does.
    expect(supportsFeature(shim, "thinking")).toBe(false)
    expect(supportsFeature(native, "thinking")).toBe(true)
  })

  it("claims nothing for a protocol nothing describes", () => {
    const unknown = externalCapabilities({ backend: "telepathy", protocol: "telepathy" as never })
    expect(featureBlockedReason(unknown, "modelPicker")).toMatch(/nothing describes/)
    expect(supportsFeature(unknown, "mcp")).toBe(false)
  })

  it("reads session resume off what the agent negotiated", () => {
    expect(
      supportsFeature(
        externalCapabilities({ backend: "claude-code", negotiated: { multiTurn: true } }),
        "resume"
      )
    ).toBe(true)
    // ACP resume is gated on the agent advertising `loadSession`, so the reason
    // names the handshake rather than blaming the protocol.
    expect(
      featureBlockedReason(externalCapabilities({ backend: "claude-code" }), "resume")
    ).toMatch(/did not advertise/)
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
    // `compact` and `resume` left this list because the native Codex
    // app-server really has `thread/compact/start` and `thread/resume`; the old
    // table had no per-protocol entry for either and greyed them out for every
    // external backend.
    const caps = externalCapabilities({ backend: "codex", presetId: "codex-app-server" })
    expect(blockedFeatures(caps)).toEqual([
      "plugins",
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
    // The `codex` preset is the ACP shim, whose only compaction route is a
    // `/compact` the agent may or may not advertise — so before any command
    // list arrives the honest answer is that nothing has verified it.
    const message = unsupportedFeatureMessage(externalCapabilities({ backend: "codex" }), "compact")
    expect(message).toContain("Context compaction")
    expect(message).toContain("codex")
    expect(message).toContain("nothing has verified this")
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

describe("effectivePermissionMode", () => {
  const caps = (protocol: string) =>
    externalCapabilities({ backend: "b", protocol: protocol as never })

  it("is the identity on the built-in sidecar, which honours every mode", () => {
    expect(effectivePermissionMode(builtinCapabilities(), "bypassPermissions")).toBe(
      "bypassPermissions"
    )
  })

  it("normalizes Cognia-only `auto` to `default` (it has no ACP rung)", () => {
    expect(effectivePermissionMode(builtinCapabilities(), "auto")).toBe("default")
    expect(effectivePermissionMode(undefined, "auto")).toBe("default")
  })

  it("passes through while still connecting (no capabilities, no protocol)", () => {
    expect(effectivePermissionMode(undefined, "bypassPermissions")).toBe("bypassPermissions")
    expect(effectivePermissionMode(caps(""), "bypassPermissions")).toBe("bypassPermissions")
  })

  it("keeps a mode the protocol can enforce", () => {
    expect(effectivePermissionMode(caps("acp"), "bypassPermissions")).toBe("bypassPermissions")
    expect(effectivePermissionMode(caps("codex-app-server"), "bypassPermissions")).toBe(
      "bypassPermissions"
    )
  })

  it("clamps down on a transport with no client-side approval loop", () => {
    // a2a / http / websocket are fire-and-forget: the remote agent owns its own
    // policy, so anything but `default` is not enforceable here.
    for (const protocol of ["a2a", "http", "websocket"]) {
      expect(effectivePermissionMode(caps(protocol), "bypassPermissions")).toBe("default")
      expect(effectivePermissionMode(caps(protocol), "acceptEdits")).toBe("default")
    }
  })

  it("drops `dontAsk` on a backend with no pre-approval registry", () => {
    expect(effectivePermissionMode(caps("codex-app-server"), "dontAsk")).toBe("plan")
  })
})
