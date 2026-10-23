import {
  __resetDynamicPresetsForTesting,
  createAgentFromPreset,
  EXTERNAL_AGENT_PRESETS,
  getAvailablePresets,
  getPresetConfig,
  getPresetDisplayInfo,
  getRunnablePresets,
  installBuiltinExternalAgentPresets,
  isFromPreset,
  registerPreset,
  resolvePreferredCodexExecutablePresetId,
  type ExternalAgentPresetConfig,
  type ExternalAgentPresetId,
} from "./presets"

const preset = (name: string, extra: Partial<ExternalAgentPresetConfig> = {}) =>
  ({
    name,
    description: `${name} preset`,
    protocol: "acp",
    transport: "stdio",
    process: { command: name, args: [] },
    defaultPermissionMode: "default",
    tags: ["test"],
    ...extra,
  }) as ExternalAgentPresetConfig

const catalog = (
  entries: Partial<Record<ExternalAgentPresetId, ExternalAgentPresetConfig | null>>
) => entries as Record<ExternalAgentPresetId, ExternalAgentPresetConfig | null>

afterEach(() => {
  __resetDynamicPresetsForTesting()
})

describe("before the host installs its catalog", () => {
  it("knows plugin presets only, and the Codex probe answers its safe default", async () => {
    expect(Object.keys(EXTERNAL_AGENT_PRESETS)).toEqual([])
    expect(getAvailablePresets()).toEqual([])
    expect(getPresetConfig("claude-code")).toBeNull()

    registerPreset("acme", preset("acme"), { pluginId: "p" })
    expect(getAvailablePresets()).toEqual(["acme"])
    expect(getPresetConfig("acme")?.name).toBe("acme")
    expect(await resolvePreferredCodexExecutablePresetId()).toBe("codex")
  })
})

describe("after the host installs its catalog", () => {
  const commandExists = jest.fn(async (command: string) => command === "codex")

  beforeAll(() => {
    installBuiltinExternalAgentPresets({
      presets: catalog({
        "claude-code": preset("claude-code"),
        "opencode-server": preset("opencode-server", { supportTier: "documented-only" }),
        custom: null,
      }),
      commandExists,
    })
  })

  it("merges builtins with plugin presets, plugin presets shadowing builtins", () => {
    expect(EXTERNAL_AGENT_PRESETS["claude-code"]?.name).toBe("claude-code")
    registerPreset("acme", preset("acme"), { pluginId: "p" })
    registerPreset("claude-code", preset("shadow"), { pluginId: "p" })
    expect(getAvailablePresets()).toEqual(["claude-code", "opencode-server", "acme"])
    expect(getRunnablePresets()).toEqual(["claude-code", "acme"])
    expect(getPresetConfig("claude-code")?.name).toBe("shadow")
    expect(getPresetDisplayInfo("acme")?.description).toBe("acme preset")
  })

  it("materializes an agent and reads its provenance back", () => {
    const agent = createAgentFromPreset("claude-code", { id: "a1" })
    expect(agent?.id).toBe("a1")
    expect(agent?.metadata?.preset).toBe("claude-code")
    expect(isFromPreset(agent!)).toBe("claude-code")
    expect(isFromPreset({ ...agent!, metadata: { preset: "custom" } })).toBeNull()
    expect(createAgentFromPreset("nope")).toBeNull()
  })

  it("probes the host for the Codex CLI", async () => {
    expect(await resolvePreferredCodexExecutablePresetId()).toBe("codex-app-server")
    commandExists.mockRejectedValueOnce(new Error("no host"))
    expect(await resolvePreferredCodexExecutablePresetId()).toBe("codex")
  })

  it("replaces the catalog on reinstall", () => {
    installBuiltinExternalAgentPresets({
      presets: catalog({ kiro: preset("kiro") }),
      commandExists,
    })
    expect(Object.keys(EXTERNAL_AGENT_PRESETS)).toEqual(["kiro"])
    expect(getPresetConfig("claude-code")).toBeNull()
  })
})
