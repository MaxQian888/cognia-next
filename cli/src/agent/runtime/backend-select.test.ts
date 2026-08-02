import {
  BUILTIN_BACKEND,
  BUILTIN_CAPABILITIES,
  capabilitiesForProtocol,
  selectBackend,
  supportsNativeSteering,
} from "./backend-select"

type Preset = { name?: string; protocol?: string }

function registry(presets: Record<string, Preset>) {
  return {
    lookupPreset: (id: string) =>
      (presets[id] ?? null) as ReturnType<
        typeof import("@/lib/ai/agent/external/presets").getPresetConfig
      >,
    listPresets: () => Object.keys(presets),
  }
}

const PRESETS = registry({
  codex: { name: "Codex CLI", protocol: "codex" },
  "claude-code": { name: "Claude Code", protocol: "acp" },
  "opencode-server": { name: "OpenCode (managed)", protocol: "opencode" },
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
      requested: "codex",
      prefers: ["steer", "mcp"],
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.backend.disabledOptional).toEqual(["steer"])
  })

  it("reports no disabled options when every preference is met", () => {
    const result = selectBackend({ ...PRESETS, prefers: ["mcp", "thinking"] })
    expect(result.ok && result.backend.disabledOptional).toEqual([])
  })
})

describe("capabilitiesForProtocol", () => {
  it("gives every external backend the conservative base set", () => {
    const base = capabilitiesForProtocol(undefined)
    expect(base).toEqual(
      expect.arrayContaining([
        "streaming",
        "session.multi-turn",
        "tools.ordinary",
        "tools.results",
        "tools.errors",
      ])
    )
    // Not assumed without proof.
    expect(base).not.toContain("mcp")
    expect(base).not.toContain("subagents.native")
  })

  it("adds protocol-specific capabilities on top of the base set", () => {
    expect(capabilitiesForProtocol("acp")).toContain("permissions.interrupt-resume")
    expect(capabilitiesForProtocol("opencode")).toContain("compaction")
    expect(capabilitiesForProtocol("codex-app-server")).toContain("steer")
  })

  it("does not duplicate a capability present in both sets", () => {
    const caps = capabilitiesForProtocol("opencode")
    expect(new Set(caps).size).toBe(caps.length)
  })

  it("treats an unknown protocol as base-only rather than guessing", () => {
    expect(capabilitiesForProtocol("telepathy")).toEqual(capabilitiesForProtocol(undefined))
  })
})

describe("supportsNativeSteering", () => {
  it("is true only for backends that advertise steer", () => {
    const steering = selectBackend({ ...PRESETS, requested: "opencode-server" })
    const notSteering = selectBackend({ ...PRESETS, requested: "codex" })
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
