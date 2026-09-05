jest.mock("@/lib/native/external-agent", () => ({ checkExternalAgentCommandExists: jest.fn() }))
import { checkExternalAgentCommandExists } from "@/lib/native/external-agent"
import type { CodexAgentOptions } from "@/types/agent/external-agent"

import {
  EXTERNAL_AGENT_PRESETS,
  BUILTIN_EXECUTABLE_PRESET_IDS,
  getAvailablePresets,
  getRunnablePresets,
  getPresetConfig,
  createAgentFromPreset,
  resolvePreferredCodexExecutablePresetId,
  isFromPreset,
  getPresetDisplayInfo,
  registerPreset,
  unregisterPreset,
  unregisterPresetsByPlugin,
  getDynamicPresetEntry,
  __resetDynamicPresetsForTesting,
  type ExternalAgentPresetConfig,
} from "./presets"

// Each test that exercises the §A-3 runtime overlay must clean up after
// itself so unrelated test suites can rely on a vanilla preset list.
afterEach(() => {
  __resetDynamicPresetsForTesting()
})

describe("EXTERNAL_AGENT_PRESETS", () => {
  it("contains the executable presets and a null custom slot", () => {
    expect(EXTERNAL_AGENT_PRESETS.codex).not.toBeNull()
    expect(EXTERNAL_AGENT_PRESETS["claude-code"]).not.toBeNull()
    expect(EXTERNAL_AGENT_PRESETS["gemini-cli"]).not.toBeNull()
    expect(EXTERNAL_AGENT_PRESETS["cursor-cli"]).not.toBeNull()
    expect(EXTERNAL_AGENT_PRESETS["copilot-cli"]).not.toBeNull()
    expect(EXTERNAL_AGENT_PRESETS.kiro).not.toBeNull()
    expect(EXTERNAL_AGENT_PRESETS["qwen-code"]).not.toBeNull()
    expect(EXTERNAL_AGENT_PRESETS.pi).not.toBeNull()
    expect(EXTERNAL_AGENT_PRESETS["pi-rpc"]).not.toBeNull()
    expect(EXTERNAL_AGENT_PRESETS.droid).not.toBeNull()
    expect(EXTERNAL_AGENT_PRESETS["opencode-acp"]).not.toBeNull()
    expect(EXTERNAL_AGENT_PRESETS.custom).toBeNull()
  })

  it("materializes the native Pi preset onto the pi-rpc protocol", () => {
    const piRpc = EXTERNAL_AGENT_PRESETS["pi-rpc"]!
    expect(piRpc.protocol).toBe("pi-rpc")
    expect(piRpc.adapterId).toBe("pi")
    expect(piRpc.surfaceId).toBe("rpc-stdio")
    expect(piRpc.process).toEqual({ command: "pi", args: ["--mode", "rpc"] })

    // `pi-rpc` is the only Pi route left. The `pi` preset was the community
    // ACP bridge; it was removed with its runtime, and re-adding it would
    // reintroduce an unpinned `npx` launch. Pin its absence.
    expect(EXTERNAL_AGENT_PRESETS.pi).toBeUndefined()
  })

  it("offers native Pi as an executable backend", () => {
    // Gates `--backend pi-rpc` and the teammate runtime picker: a preset that
    // names a real binary but is missing here is silently unselectable.
    expect(BUILTIN_EXECUTABLE_PRESET_IDS).toContain("pi-rpc")
  })

  it("offers the official OpenCode ACP command as an executable preset", () => {
    const preset = EXTERNAL_AGENT_PRESETS["opencode-acp"]!
    expect(preset).toEqual(
      expect.objectContaining({
        protocol: "acp",
        transport: "stdio",
        process: { command: "opencode", args: ["acp"] },
        supportTier: "executable",
      })
    )
    expect(BUILTIN_EXECUTABLE_PRESET_IDS).toContain("opencode-acp")
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

describe("BUILTIN_EXECUTABLE_PRESET_IDS", () => {
  it("excludes custom, preview integrations, and managed-runtime backends", () => {
    // The DeepSeek Harness presets name no binary on PATH: they become runnable
    // only after the managed runtime is installed, so offering them as spawnable
    // backends would produce choices that cannot spawn.
    const nonExecutable = [
      "custom",
      "opencode-v2-preview",
      "deepseek-harness-readonly",
      "deepseek-harness-workspace",
      "deepseek-harness-acp",
    ]
    const expected = (
      Object.keys(EXTERNAL_AGENT_PRESETS) as Array<keyof typeof EXTERNAL_AGENT_PRESETS>
    ).filter((id) => !nonExecutable.includes(id) && EXTERNAL_AGENT_PRESETS[id] !== null)
    expect(BUILTIN_EXECUTABLE_PRESET_IDS).toEqual(expected)
    for (const id of nonExecutable) {
      expect(BUILTIN_EXECUTABLE_PRESET_IDS).not.toContain(id)
    }
  })

  it("includes both Claude Code and Codex (the named external agents)", () => {
    expect(BUILTIN_EXECUTABLE_PRESET_IDS).toEqual(
      expect.arrayContaining(["claude-code", "codex", "codex-app-server"])
    )
  })

  it("keeps the stale OpenCode V2 preview contract documented-only", () => {
    expect(EXTERNAL_AGENT_PRESETS["opencode-v2-preview"]?.supportTier).toBe("documented-only")
  })

  it("only lists ids that resolve to a real preset config", () => {
    for (const id of BUILTIN_EXECUTABLE_PRESET_IDS) {
      expect(getPresetConfig(id)).not.toBeNull()
    }
  })
})

describe("getAvailablePresets", () => {
  it("excludes 'custom' and includes the executable preset ids", () => {
    const ids = getAvailablePresets()
    expect(ids).toContain("codex")
    expect(ids).toContain("claude-code")
    expect(ids).toContain("gemini-cli")
    expect(ids).toContain("cursor-cli")
    expect(ids).toContain("copilot-cli")
    expect(ids).toContain("kiro")
    expect(ids).toContain("qwen-code")
    expect(ids).toContain("pi-rpc")
    expect(ids).toContain("droid")
    expect(ids).not.toContain("pi")
    expect(ids).not.toContain("custom")
  })

  it("keeps documented-only presets discoverable but out of runnable choices", () => {
    expect(getAvailablePresets()).toContain("opencode-v2-preview")
    expect(getRunnablePresets()).not.toContain("opencode-v2-preview")
    expect(getRunnablePresets()).toContain("opencode-acp")
  })
})

describe("OpenCode presets", () => {
  it("exposes auto-spawn and remote OpenCode presets", () => {
    const server = EXTERNAL_AGENT_PRESETS["opencode-server"]!
    expect(server.protocol).toBe("opencode")
    expect(server.transport).toBe("sse")
    expect(server.process?.command).toBe("opencode")
    // spawnServer prepends "serve" itself — a preset-provided "serve" would
    // produce `opencode serve ... serve` and the CLI rejects the extra arg.
    expect(server.process?.args).toEqual([])
    expect(server.metadata?.autoSpawnServer).toBe(true)

    const remote = EXTERNAL_AGENT_PRESETS["opencode-remote"]!
    expect(remote.protocol).toBe("opencode")
    expect(remote.network?.endpoint).toBeTruthy()
    expect(remote.metadata?.autoSpawnServer).toBeUndefined()

    const ids = getAvailablePresets()
    expect(ids).toContain("opencode-server")
    expect(ids).toContain("opencode-remote")
  })

  it("materializes the auto-spawn flag into agent metadata", () => {
    const cfg = createAgentFromPreset("opencode-server")!
    expect(cfg.protocol).toBe("opencode")
    expect(cfg.process?.command).toBe("opencode")
    expect(cfg.metadata?.autoSpawnServer).toBe(true)
    expect(cfg.metadata?.preset).toBe("opencode-server")
  })

  it("lets overrides win over preset metadata", () => {
    const cfg = createAgentFromPreset("opencode-server", {
      metadata: { autoSpawnServer: false, serverPassword: "x" },
    })!
    expect(cfg.metadata?.autoSpawnServer).toBe(false)
    expect(cfg.metadata?.serverPassword).toBe("x")
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
    expect(cfg.process?.args).toEqual(["-y", "@google/gemini-cli", "--acp"])
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

describe("new ACP presets", () => {
  it.each(["copilot-cli", "kiro", "qwen-code", "droid"])(
    "materializes an executable ACP stdio agent from %s",
    (presetId) => {
      const preset = getPresetConfig(presetId)!
      expect(preset.protocol).toBe("acp")
      expect(preset.transport).toBe("stdio")
      expect(preset.supportTier).toBe("executable")
      expect(preset.process?.command).toBeTruthy()

      const cfg = createAgentFromPreset(presetId)!
      expect(cfg.protocol).toBe("acp")
      expect(cfg.metadata?.preset).toBe(presetId)
      expect(cfg.metadata?.ecosystemSurfaceId).toBe("acp-stdio")
      expect(isFromPreset(cfg)).toBe(presetId)
    }
  )
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

// ============================================================================
// §A-3 — runtime preset overlay (plugin contributions)
// ============================================================================

describe("runtime preset overlay", () => {
  // Minimal but legal preset config used to fake plugin contributions.
  const fakeConfig: ExternalAgentPresetConfig = {
    name: "Fake Plugin Agent",
    description: "Test fixture for plugin presets",
    protocol: "acp",
    transport: "stdio",
    process: { command: "fake", args: [] },
    defaultPermissionMode: "default",
    tags: ["fake"],
  }

  it("registerPreset adds a dynamic preset that getAvailablePresets surfaces", () => {
    expect(getAvailablePresets()).not.toContain("plugin-x")
    registerPreset("plugin-x", fakeConfig, { pluginId: "plug" })
    expect(getAvailablePresets()).toContain("plugin-x")
    expect(getPresetConfig("plugin-x")?.name).toBe("Fake Plugin Agent")
    expect(getDynamicPresetEntry("plugin-x")?.pluginId).toBe("plug")
  })

  it("rejects a cross-plugin re-registration (first-wins) but allows same-plugin refresh", () => {
    registerPreset("plugin-x", fakeConfig, { pluginId: "plug-1" })

    // W4.2: a DIFFERENT plugin may not hijack the id — the incumbent wins.
    const prev = registerPreset(
      "plugin-x",
      { ...fakeConfig, name: "Hijacked" },
      { pluginId: "plug-2" }
    )
    expect(prev?.pluginId).toBe("plug-1")
    expect(getPresetConfig("plugin-x")?.name).toBe("Fake Plugin Agent")
    expect(getDynamicPresetEntry("plugin-x")?.pluginId).toBe("plug-1")

    // The SAME plugin still refreshes its own entry (hot reload).
    registerPreset("plugin-x", { ...fakeConfig, name: "Updated" }, { pluginId: "plug-1" })
    expect(getPresetConfig("plugin-x")?.name).toBe("Updated")
  })

  it("unregisterPreset removes a single entry; idempotent second call returns false", () => {
    registerPreset("plugin-y", fakeConfig)
    expect(unregisterPreset("plugin-y")).toBe(true)
    expect(unregisterPreset("plugin-y")).toBe(false)
    expect(getPresetConfig("plugin-y")).toBeNull()
  })

  it("unregisterPresetsByPlugin only removes entries owned by that plugin", () => {
    registerPreset("a", fakeConfig, { pluginId: "p1" })
    registerPreset("b", fakeConfig, { pluginId: "p1" })
    registerPreset("c", fakeConfig, { pluginId: "p2" })
    registerPreset("d", fakeConfig) // no pluginId

    const removed = unregisterPresetsByPlugin("p1")
    expect(removed).toBe(2)
    expect(getPresetConfig("a")).toBeNull()
    expect(getPresetConfig("b")).toBeNull()
    // Other plugin's entry survives.
    expect(getPresetConfig("c")).not.toBeNull()
    // Anonymously registered entry survives.
    expect(getPresetConfig("d")).not.toBeNull()
  })

  it("dynamic preset shadows a static preset id (plugin-wins, fallback restored after unregister)", () => {
    const builtinName = getPresetConfig("claude-code")!.name
    expect(builtinName).toBeTruthy()

    registerPreset(
      "claude-code",
      { ...fakeConfig, name: "Plugin claude-code" },
      { pluginId: "shadower" }
    )
    expect(getPresetConfig("claude-code")?.name).toBe("Plugin claude-code")

    // After unregistering the plugin, the static record reappears.
    unregisterPresetsByPlugin("shadower")
    expect(getPresetConfig("claude-code")?.name).toBe(builtinName)
  })

  it("createAgentFromPreset works for a plugin-registered preset id", () => {
    registerPreset("plugin-z", fakeConfig, { pluginId: "plug" })
    const cfg = createAgentFromPreset("plugin-z")
    expect(cfg).not.toBeNull()
    expect(cfg!.protocol).toBe("acp")
    expect(cfg!.process?.command).toBe("fake")
    expect(cfg!.metadata?.preset).toBe("plugin-z")
  })

  it("isFromPreset recognizes plugin-contributed preset ids", () => {
    registerPreset("plugin-id-1", fakeConfig)
    const cfg = createAgentFromPreset("plugin-id-1")!
    expect(isFromPreset(cfg)).toBe("plugin-id-1")
  })

  it("getPresetDisplayInfo returns plugin-contributed display fields", () => {
    registerPreset("plugin-disp", fakeConfig)
    const info = getPresetDisplayInfo("plugin-disp")
    expect(info?.name).toBe("Fake Plugin Agent")
    expect(info?.tags).toEqual(["fake"])
  })

  it("getAvailablePresets does not duplicate when a plugin shadows a static id", () => {
    registerPreset("codex", fakeConfig, { pluginId: "p" })
    const ids = getAvailablePresets()
    const codexCount = ids.filter((id) => id === "codex").length
    expect(codexCount).toBe(1)
  })

  it("__resetDynamicPresetsForTesting clears the overlay", () => {
    registerPreset("a", fakeConfig)
    registerPreset("b", fakeConfig)
    __resetDynamicPresetsForTesting()
    expect(getPresetConfig("a")).toBeNull()
    expect(getPresetConfig("b")).toBeNull()
  })
})

describe("explicit Codex ACP and native options", () => {
  it("lists an explicit ACP preset with its own identity and the existing shim command", () => {
    expect(getAvailablePresets()).toContain("codex-acp")
    expect(getRunnablePresets()).toContain("codex-acp")
    expect(BUILTIN_EXECUTABLE_PRESET_IDS).toContain("codex-acp")
    const config = createAgentFromPreset("codex-acp")!
    expect(config).toMatchObject({
      name: "Codex (ACP)",
      protocol: "acp",
      transport: "stdio",
      metadata: {
        preset: "codex-acp",
        ecosystemAdapterId: "codex",
        ecosystemSurfaceId: "acp-stdio",
        ecosystemSupportTier: "executable",
      },
    })
    expect(config.process).toEqual(createAgentFromPreset("codex")!.process)
    expect(isFromPreset(config)).toBe("codex-acp")
  })

  it.each(["codex-app-server", "codex", "codex-acp"])(
    "preserves caller Codex options when materializing %s",
    (id) => {
      const codexOptions: CodexAgentOptions = {
        sandboxMode: "workspaceWrite",
        networkAccess: false,
        writableRoots: ["/repo/output"],
        extraSkillRoots: ["/repo/skills"],
        defaultReasoningEffort: "high",
        reasoningSummary: "concise",
      }
      const config = createAgentFromPreset(id, { codexOptions })!
      expect(config.codexOptions).toEqual(codexOptions)
      expect(config.codexOptions?.networkAccess).toBe(false)
      expect(createAgentFromPreset(id)!.codexOptions).toBeUndefined()
      expect(createAgentFromPreset(id, { codexOptions: {} })!.codexOptions).toEqual({})
    }
  )

  it("keeps codex automatic native preference and its compatibility fallback", async () => {
    const check = jest.mocked(checkExternalAgentCommandExists)
    check.mockResolvedValueOnce(true)
    expect(await resolvePreferredCodexExecutablePresetId()).toBe("codex-app-server")
    check.mockResolvedValueOnce(false)
    expect(await resolvePreferredCodexExecutablePresetId()).toBe("codex")
    check.mockRejectedValueOnce(new Error("offline probe unavailable"))
    expect(await resolvePreferredCodexExecutablePresetId()).toBe("codex")
    check.mockClear()
    expect(createAgentFromPreset("codex-acp")?.protocol).toBe("acp")
    expect(check).not.toHaveBeenCalled()
  })
})
