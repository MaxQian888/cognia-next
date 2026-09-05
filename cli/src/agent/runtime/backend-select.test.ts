import {
  BUILTIN_BACKEND,
  BUILTIN_CAPABILITIES,
  capabilitiesForProtocol,
  selectBackend,
  supportsNativeSteering,
} from "./backend-select"

type Preset = { name?: string; protocol?: string; supportTier?: "executable" | "documented-only" }

function registry(presets: Record<string, Preset>) {
  return {
    lookupPreset: (id: string) =>
      (presets[id] ?? null) as ReturnType<
        typeof import("@/lib/ai/agent/external/presets").getPresetConfig
      >,
    listPresets: () => Object.keys(presets),
  }
}

// Real protocol ids. The old fixture used `protocol: "codex"`, which is not a
// protocol any adapter registers — it only "worked" because the private
// capability table happened to have a key by that name.
const PRESETS = registry({
  codex: { name: "Codex CLI", protocol: "codex-app-server" },
  "claude-code": { name: "Claude Code", protocol: "acp" },
  "opencode-server": { name: "OpenCode (managed)", protocol: "opencode" },
  "opencode-v2-preview": {
    name: "OpenCode V2 legacy preview",
    protocol: "opencode-v2",
    supportTier: "documented-only",
  },
  mystery: { name: "Mystery Agent" },
})

describe("selectBackend — resolution", () => {
  it("defaults to the built-in sidecar with the full capability set", () => {
    const result = selectBackend(PRESETS)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.backend).toMatchObject({ id: BUILTIN_BACKEND, kind: "builtin" })
    expect(result.backend.capabilities).toEqual([...BUILTIN_CAPABILITIES])
  })

  it("treats an explicit builtin and an empty string as the sidecar", () => {
    expect(selectBackend({ ...PRESETS, requested: "builtin" }).ok).toBe(true)
    const blank = selectBackend({ ...PRESETS, requested: "   " })
    expect(blank.ok && blank.backend.id).toBe(BUILTIN_BACKEND)
  })

  it("resolves a registered external preset and reports its display name", () => {
    const result = selectBackend({ ...PRESETS, requested: "codex" })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.backend).toMatchObject({
      id: "codex",
      kind: "external",
      displayName: "Codex CLI",
    })
  })

  it("rejects a documented-only backend even when it resolves", () => {
    const result = selectBackend({ ...PRESETS, requested: "opencode-v2-preview" })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe("usage_error")
    expect(result.error.message).toContain("documented-only")
  })

  it("never silently substitutes — an unknown backend is a usage error listing the valid ids", () => {
    const result = selectBackend({ ...PRESETS, requested: "codexx" })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe("usage_error")
    expect(result.error.message).toContain('unknown backend "codexx"')
    expect(result.error.message).toContain("builtin")
    expect(result.error.message).toContain("codex")
    expect(result.error.detail).toMatchObject({ requested: "codexx" })
  })

  it("falls back to the id as display name when the preset has none", () => {
    const result = selectBackend({ ...PRESETS, requested: "mystery" })
    expect(result.ok && result.backend.displayName).toBe("Mystery Agent")
  })
})

describe("selectBackend — capabilities", () => {
  it("does not advertise native Claude capabilities on the AI SDK rail", () => {
    const result = selectBackend({ ...PRESETS, provider: "deepseek" })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.backend.runtimeAdapter).toBe("ai-sdk")
    expect(result.backend.capabilities).not.toContain("subagents.native")
    expect(result.backend.capabilities).toContain("session.resume")
    expect(result.backend.capabilities).toContain("tools.fragmented-json")
    expect(
      selectBackend({ ...PRESETS, provider: "deepseek", requires: ["subagents.native"] }).ok
    ).toBe(false)
  })
  it("passes when every hard requirement is met", () => {
    const result = selectBackend({
      ...PRESETS,
      requested: "codex",
      requires: ["streaming", "mcp", "session.resume"],
    })
    expect(result.ok).toBe(true)
  })

  it("fails with unsupported_capability naming the missing one", () => {
    const result = selectBackend({
      ...PRESETS,
      requested: "mystery",
      requires: ["mcp"],
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe("unsupported_capability")
    expect(result.error.capability).toBe("mcp")
    expect(result.error.message).toContain('backend "mystery"')
    expect(result.error.detail).toMatchObject({ backend: "mystery", missing: ["mcp"] })
  })

  it("reports every missing requirement, not just the first", () => {
    const result = selectBackend({
      ...PRESETS,
      requested: "mystery",
      requires: ["mcp", "subagents.native"],
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.detail).toMatchObject({ missing: ["mcp", "subagents.native"] })
  })

  it("checks existence before capability, so a typo reads as a typo", () => {
    const result = selectBackend({
      ...PRESETS,
      requested: "codexx",
      requires: ["mcp"],
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe("usage_error")
  })

  it("reports an unmet preference without failing the run", () => {
    const result = selectBackend({
      ...PRESETS,
      requested: "claude-code",
      prefers: ["steer", "mcp"],
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    // ACP has no mid-turn input method; it does carry MCP servers at
    // `session/new`.
    expect(result.backend.disabledOptional).toEqual(["steer"])
  })

  it("reports no disabled options when every preference is met", () => {
    const result = selectBackend({ ...PRESETS, prefers: ["mcp", "thinking"] })
    expect(result.ok && result.backend.disabledOptional).toEqual([])
  })
})

describe("capabilitiesForProtocol", () => {
  it("reports the protocol's own capabilities, not a shared base set", () => {
    // There is no longer a "base set every external agent has". A2A, for
    // instance, negotiates streaming per Agent Card, so claiming it statically
    // would be a guess — and the old base set did exactly that for all seven.
    const acp = capabilitiesForProtocol("acp")
    expect(acp).toEqual(
      expect.arrayContaining([
        "streaming",
        "session.multi-turn",
        "tools.ordinary",
        "tools.results",
        "tools.errors",
        "mcp",
        "permissions.interrupt-resume",
      ])
    )
    expect(capabilitiesForProtocol("a2a")).not.toContain("streaming")
  })

  it("no longer claims steering for OpenCode", () => {
    // The old table listed `steer` for opencode. Its adapter has no
    // `steerTurn`, and the protocol has no mid-turn input method, so a
    // `--requires steer` run was admitted here and failed at the first steer.
    expect(capabilitiesForProtocol("opencode")).not.toContain("steer")
    expect(capabilitiesForProtocol("codex-app-server")).toContain("steer")
  })

  it("does not claim MCP for protocols that cannot carry a server", () => {
    // Only ACP forwards MCP servers at `session/new`; Codex reaches the same
    // outcome through a per-thread config override. OpenCode and Pi have no
    // per-session channel at all.
    expect(capabilitiesForProtocol("acp")).toContain("mcp")
    expect(capabilitiesForProtocol("codex-app-server")).toContain("mcp")
    expect(capabilitiesForProtocol("opencode")).not.toContain("mcp")
    expect(capabilitiesForProtocol("pi-rpc")).not.toContain("mcp")
  })

  it("does not duplicate a capability", () => {
    const caps = capabilitiesForProtocol("opencode")
    expect(new Set(caps).size).toBe(caps.length)
  })

  it("claims nothing for a protocol nothing describes", () => {
    // An unknown protocol has no manifest row, so every capability is
    // `unknown` — and `unknown` is never usable. Answering with a base set here
    // is how an unrecognized backend used to be credited with streaming.
    expect(capabilitiesForProtocol("telepathy")).toEqual([])
    expect(capabilitiesForProtocol(undefined)).toEqual([])
  })
})

describe("supportsNativeSteering", () => {
  it("is true only for backends whose protocol has a mid-turn input method", () => {
    const steering = selectBackend({ ...PRESETS, requested: "codex" })
    const notSteering = selectBackend({ ...PRESETS, requested: "opencode-server" })
    expect(steering.ok && supportsNativeSteering(steering.backend)).toBe(true)
    expect(notSteering.ok && supportsNativeSteering(notSteering.backend)).toBe(false)
  })

  it("is false for the built-in sidecar, which queues after settle", () => {
    const builtin = selectBackend(PRESETS)
    expect(builtin.ok && supportsNativeSteering(builtin.backend)).toBe(false)
  })
})

describe("the real preset registry", () => {
  it("resolves a shipped preset without injected lookups", () => {
    const result = selectBackend({ requested: "codex" })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.backend.kind).toBe("external")
  })

  it("still rejects an unknown id against the real registry", () => {
    expect(selectBackend({ requested: "not-a-real-backend" }).ok).toBe(false)
  })
})
