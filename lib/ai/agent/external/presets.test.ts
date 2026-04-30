import {
  EXTERNAL_AGENT_PRESETS,
  getAvailablePresets,
  getPresetConfig,
  createAgentFromPreset,
  isFromPreset,
  getPresetDisplayInfo,
} from "./presets"

describe("EXTERNAL_AGENT_PRESETS", () => {
  it("contains the four executable presets and a null custom slot", () => {
    expect(EXTERNAL_AGENT_PRESETS.codex).not.toBeNull()
    expect(EXTERNAL_AGENT_PRESETS["claude-code"]).not.toBeNull()
    expect(EXTERNAL_AGENT_PRESETS["gemini-cli"]).not.toBeNull()
    expect(EXTERNAL_AGENT_PRESETS["cursor-cli"]).not.toBeNull()
    expect(EXTERNAL_AGENT_PRESETS.custom).toBeNull()
  })

  it("each preset carries adapter/surface metadata", () => {
    const codex = EXTERNAL_AGENT_PRESETS.codex!
    expect(codex.adapterId).toBe("codex")
    expect(codex.surfaceId).toBe("acp-stdio")
    expect(codex.protocol).toBe("acp")
    expect(codex.transport).toBe("stdio")
    expect(codex.supportTier).toBe("executable")
    expect(codex.process).toBeDefined()
    expect(codex.tags.length).toBeGreaterThan(0)
  })
})

describe("getAvailablePresets", () => {
  it("excludes 'custom' and includes the four executable preset ids", () => {
    const ids = getAvailablePresets()
    expect(ids).toContain("codex")
    expect(ids).toContain("claude-code")
    expect(ids).toContain("gemini-cli")
    expect(ids).toContain("cursor-cli")
    expect(ids).not.toContain("custom")
  })
})

describe("getPresetConfig", () => {
  it("returns the preset for a known id", () => {
    expect(getPresetConfig("codex")?.adapterId).toBe("codex")
  })

  it("returns null for the custom slot", () => {
    expect(getPresetConfig("custom")).toBeNull()
  })
})

describe("createAgentFromPreset", () => {
  it("returns null for the unknown 'custom' slot", () => {
    expect(createAgentFromPreset("custom")).toBeNull()
  })

  it("creates a config from the codex preset", () => {
    const cfg = createAgentFromPreset("codex")
    expect(cfg).toBeTruthy()
    expect(cfg!.protocol).toBe("acp")
    expect(cfg!.transport).toBe("stdio")
    expect(cfg!.enabled).toBe(true)
    expect(cfg!.id).toBeTruthy()
    expect(cfg!.timeout).toBe(30000)
    expect(cfg!.metadata?.preset).toBe("codex")
    expect(cfg!.metadata?.ecosystemAdapterId).toBe("codex")
    expect(cfg!.metadata?.ecosystemSurfaceId).toBe("acp-stdio")
    expect(cfg!.process?.command).toBe("npx")
    expect(cfg!.network).toBeUndefined()
  })

  it("honors overrides for id, name, env, and metadata", () => {
    const cfg = createAgentFromPreset("claude-code", {
      id: "custom-id",
      name: "My Agent",
      enabled: false,
      defaultPermissionMode: "plan",
      tags: ["extra"],
      timeout: 12345,
      process: { command: "alt", args: ["--flag"], env: { EXTRA: "1" }, cwd: "/tmp" },
      metadata: { preset: "claude-code", custom: 1 },
    })
    expect(cfg!.id).toBe("custom-id")
    expect(cfg!.name).toBe("My Agent")
    expect(cfg!.enabled).toBe(false)
    expect(cfg!.defaultPermissionMode).toBe("plan")
    expect(cfg!.timeout).toBe(12345)
    expect(cfg!.process?.command).toBe("alt")
    expect(cfg!.process?.args).toEqual(["--flag"])
    expect(cfg!.process?.env?.EXTRA).toBe("1")
    expect(cfg!.process?.cwd).toBe("/tmp")
    expect(cfg!.tags).toEqual(expect.arrayContaining(["coding", "anthropic", "claude", "extra"]))
    expect(cfg!.metadata?.custom).toBe(1)
    expect(cfg!.metadata?.preset).toBe("claude-code")
  })

  it("falls back to preset defaults when overrides are missing", () => {
    const cfg = createAgentFromPreset("gemini-cli")!
    expect(cfg.name).toBeDefined()
    expect(cfg.process?.args).toEqual(["-y", "@google/gemini-cli", "--stdio"])
  })

  it("preserves network field when preset has one (synthetic)", () => {
    // No preset has network; this branch only fires when overrides supply one
    // for a preset that lacks network. Simulate by constructing one manually.
    const cfg = createAgentFromPreset("codex", {
      network: { endpoint: "http://example.test" },
    })
    expect(cfg!.network?.endpoint).toBe("http://example.test")
  })
})

describe("isFromPreset", () => {
  it("returns the preset id when metadata.preset is recognized", () => {
    const cfg = createAgentFromPreset("cursor-cli")!
    expect(isFromPreset(cfg)).toBe("cursor-cli")
  })

  it("returns null when metadata.preset is missing or unrecognized", () => {
    expect(isFromPreset({ metadata: {} } as never)).toBeNull()
    expect(isFromPreset({ metadata: { preset: "ghost" } } as never)).toBeNull()
    expect(isFromPreset({} as never)).toBeNull()
  })
})

describe("getPresetDisplayInfo", () => {
  it("returns display info for executable presets", () => {
    const info = getPresetDisplayInfo("codex")
    expect(info?.name).toBeTruthy()
    expect(info?.description).toBeTruthy()
    expect(Array.isArray(info?.tags)).toBe(true)
  })

  it("returns null for the custom slot", () => {
    expect(getPresetDisplayInfo("custom")).toBeNull()
  })
})
