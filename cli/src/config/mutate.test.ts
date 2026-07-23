/**
 * @jest-environment node
 */
import {
  customThemePath,
  setBooleanFlag,
  setBuiltinHookOverride,
  setBuiltinTools,
  setClipboardConfig,
  setConfigValue,
  setCustomTheme,
  setEditorConfig,
  setGitWorkflowConfig,
  setKeybindings,
  setLoggingConfig,
  setNumberConfig,
  setMascotConfig,
  setPluginToolsConfig,
  setProviderBaseURL,
  setProviderExperimentalAgentSdk,
  setProviderModel,
  setRenderConfig,
  setStatusBarConfig,
  setStringArrayConfig,
  setSubagentModel,
  SETTABLE_KEYS,
  type ConfigMutateFs,
} from "./mutate"
import { userConfigPath } from "./load"

const HOME = "/home/u/.cognia"

function memFs(seed: Record<string, string> = {}) {
  const files = new Map<string, string>(Object.entries(seed))
  const fsx: ConfigMutateFs = {
    read: (p) => (files.has(p) ? files.get(p)! : null),
    write: (p, content) => void files.set(p, content),
    mkdirp: () => undefined,
  }
  return { fsx, files }
}

describe("setConfigValue", () => {
  it("writes a new config.json with the value", () => {
    const m = memFs()
    const target = setConfigValue(HOME, "provider", "openai", m.fsx)
    expect(target).toBe(userConfigPath(HOME))
    expect(JSON.parse(m.files.get(target)!)).toEqual({ provider: "openai" })
  })

  it("persists the external-agent backend", () => {
    const m = memFs()
    setConfigValue(HOME, "agentBackend", "claude-code", m.fsx)
    expect(JSON.parse(m.files.get(userConfigPath(HOME))!)).toEqual({
      agentBackend: "claude-code",
    })
  })

  it("merges with existing config, preserving other keys", () => {
    const m = memFs({
      [userConfigPath(HOME)]: JSON.stringify({ provider: "openai", model: "old" }),
    })
    setConfigValue(HOME, "model", "new", m.fsx)
    expect(JSON.parse(m.files.get(userConfigPath(HOME))!)).toEqual({
      provider: "openai",
      model: "new",
    })
  })

  it("rejects an unknown key", () => {
    expect(() => setConfigValue(HOME, "bogus", "x", memFs().fsx)).toThrow(/unknown config key/)
  })

  it("validates the value against the schema (bad permissionMode)", () => {
    expect(() => setConfigValue(HOME, "permissionMode", "yolo", memFs().fsx)).toThrow()
  })

  it("accepts every settable key", () => {
    const valueFor: Partial<Record<(typeof SETTABLE_KEYS)[number], string>> = {
      permissionMode: "default",
      thinkingLevel: "high",
      outputStyle: "concise",
      skillLoadMode: "name",
    }
    for (const key of SETTABLE_KEYS) {
      const value = valueFor[key] ?? "v"
      expect(() => setConfigValue(HOME, key, value, memFs().fsx)).not.toThrow()
    }
  })

  it("persists the theme and preserves other keys", () => {
    const m = memFs({
      [userConfigPath(HOME)]: JSON.stringify({ provider: "openai", theme: "classic" }),
    })
    setConfigValue(HOME, "theme", "dark", m.fsx)
    expect(JSON.parse(m.files.get(userConfigPath(HOME))!)).toEqual({
      provider: "openai",
      theme: "dark",
    })
  })

  it("does not clobber the theme when updating statusBar", () => {
    const m = memFs({
      [userConfigPath(HOME)]: JSON.stringify({ provider: "openai", theme: "dark" }),
    })
    setStatusBarConfig(HOME, { theme: "dim" }, m.fsx)
    expect(JSON.parse(m.files.get(userConfigPath(HOME))!)).toEqual({
      provider: "openai",
      theme: "dark",
      statusBar: { theme: "dim" },
    })
  })

  it("does not clobber the theme when updating mascot", () => {
    const m = memFs({
      [userConfigPath(HOME)]: JSON.stringify({ provider: "openai", theme: "dark" }),
    })
    setMascotConfig(HOME, { style: "cat" }, m.fsx)
    expect(JSON.parse(m.files.get(userConfigPath(HOME))!)).toEqual({
      provider: "openai",
      theme: "dark",
      mascot: { style: "cat" },
    })
  })

  it("does not clobber the theme when updating a provider model", () => {
    const m = memFs({
      [userConfigPath(HOME)]: JSON.stringify({ provider: "openai", theme: "dark" }),
    })
    setProviderModel(HOME, "openai", "gpt-5", m.fsx)
    expect(JSON.parse(m.files.get(userConfigPath(HOME))!)).toEqual({
      provider: "openai",
      theme: "dark",
      providers: { openai: { model: "gpt-5" } },
    })
  })

  it("rejects an invalid thinking level", () => {
    expect(() => setConfigValue(HOME, "thinkingLevel", "ultra", memFs().fsx)).toThrow()
  })
})

describe("setProviderModel", () => {
  it("writes the model under the provider's slot", () => {
    const m = memFs()
    const target = setProviderModel(HOME, "deepseek", "deepseek-reasoner", m.fsx)
    expect(target).toBe(userConfigPath(HOME))
    expect(JSON.parse(m.files.get(target)!)).toEqual({
      providers: { deepseek: { model: "deepseek-reasoner" } },
    })
  })

  it("preserves other providers and the provider's other keys", () => {
    const m = memFs({
      [userConfigPath(HOME)]: JSON.stringify({
        provider: "deepseek",
        providers: {
          deepseek: { apiKey: "k", model: "old" },
          openai: { model: "gpt-4.1" },
        },
      }),
    })
    setProviderModel(HOME, "deepseek", "deepseek-reasoner", m.fsx)
    expect(JSON.parse(m.files.get(userConfigPath(HOME))!)).toEqual({
      provider: "deepseek",
      providers: {
        deepseek: { apiKey: "k", model: "deepseek-reasoner" },
        openai: { model: "gpt-4.1" },
      },
    })
  })

  it("clears a legacy top-level model pin while writing the per-provider value", () => {
    const m = memFs({
      [userConfigPath(HOME)]: JSON.stringify({ provider: "deepseek", model: "claude-opus-4-8" }),
    })
    setProviderModel(HOME, "deepseek", "deepseek-chat", m.fsx)
    const written = JSON.parse(m.files.get(userConfigPath(HOME))!)
    expect(written.model).toBeUndefined()
    expect(written).toEqual({
      provider: "deepseek",
      providers: { deepseek: { model: "deepseek-chat" } },
    })
  })
})

describe("setProviderBaseURL", () => {
  it("writes the base URL under the provider's slot", () => {
    const m = memFs()
    const target = setProviderBaseURL(HOME, "deepseek", "https://relay.example.com/v1", m.fsx)
    expect(target).toBe(userConfigPath(HOME))
    expect(JSON.parse(m.files.get(target)!)).toEqual({
      providers: { deepseek: { baseURL: "https://relay.example.com/v1" } },
    })
  })

  it("preserves other providers and the provider's other keys", () => {
    const m = memFs({
      [userConfigPath(HOME)]: JSON.stringify({
        provider: "deepseek",
        providers: {
          deepseek: { apiKey: "k", model: "deepseek-chat" },
          openai: { model: "gpt-4.1" },
        },
      }),
    })
    setProviderBaseURL(HOME, "deepseek", "https://relay.example.com/v1", m.fsx)
    expect(JSON.parse(m.files.get(userConfigPath(HOME))!)).toEqual({
      provider: "deepseek",
      providers: {
        deepseek: { apiKey: "k", model: "deepseek-chat", baseURL: "https://relay.example.com/v1" },
        openai: { model: "gpt-4.1" },
      },
    })
  })

  it("clears the base URL override when passed null, preserving the rest of the entry", () => {
    const m = memFs({
      [userConfigPath(HOME)]: JSON.stringify({
        providers: { deepseek: { apiKey: "k", baseURL: "https://relay.example.com/v1" } },
      }),
    })
    setProviderBaseURL(HOME, "deepseek", null, m.fsx)
    expect(JSON.parse(m.files.get(userConfigPath(HOME))!)).toEqual({
      providers: { deepseek: { apiKey: "k" } },
    })
  })

  it("rejects a malformed URL (schema validation)", () => {
    expect(() => setProviderBaseURL(HOME, "deepseek", "not-a-url", memFs().fsx)).toThrow()
  })

  it("rejects an empty provider id", () => {
    expect(() => setProviderBaseURL(HOME, "  ", "https://x/v1", memFs().fsx)).toThrow(
      /provider id is required/
    )
  })
})

describe("setStatusBarConfig", () => {
  it("writes a statusBar object into a fresh config", () => {
    const m = memFs()
    setStatusBarConfig(HOME, { theme: "dim" }, m.fsx)
    expect(JSON.parse(m.files.get(userConfigPath(HOME))!)).toEqual({ statusBar: { theme: "dim" } })
  })

  it("merges into an existing statusBar, preserving other keys", () => {
    const m = memFs({
      [userConfigPath(HOME)]: JSON.stringify({
        provider: "openai",
        statusBar: { theme: "vivid", segments: ["model"] },
      }),
    })
    setStatusBarConfig(HOME, { segments: ["mode", "cost"] }, m.fsx)
    expect(JSON.parse(m.files.get(userConfigPath(HOME))!)).toEqual({
      provider: "openai",
      statusBar: { theme: "vivid", segments: ["mode", "cost"] },
    })
  })

  it("validates the patch against the schema (bad theme)", () => {
    expect(() => setStatusBarConfig(HOME, { theme: "neon" as never }, memFs().fsx)).toThrow()
  })
})

describe("setMascotConfig", () => {
  it("writes a mascot object into a fresh config", () => {
    const m = memFs()
    setMascotConfig(HOME, { style: "cat" }, m.fsx)
    expect(JSON.parse(m.files.get(userConfigPath(HOME))!)).toEqual({ mascot: { style: "cat" } })
  })

  it("merges into an existing mascot, preserving other keys", () => {
    const m = memFs({
      [userConfigPath(HOME)]: JSON.stringify({
        provider: "openai",
        mascot: { enabled: true, style: "clawd" },
      }),
    })
    setMascotConfig(HOME, { style: "robot" }, m.fsx)
    expect(JSON.parse(m.files.get(userConfigPath(HOME))!)).toEqual({
      provider: "openai",
      mascot: { enabled: true, style: "robot" },
    })
  })

  it("validates the patch against the schema (bad style)", () => {
    expect(() => setMascotConfig(HOME, { style: "dragon" as never }, memFs().fsx)).toThrow()
  })
})

describe("setEditorConfig", () => {
  it("writes an editor object into a fresh config", () => {
    const m = memFs()
    setEditorConfig(HOME, { command: "code" }, m.fsx)
    expect(JSON.parse(m.files.get(userConfigPath(HOME))!)).toEqual({ editor: { command: "code" } })
  })

  it("normalizes a stored string editor before merging the patch", () => {
    const m = memFs({ [userConfigPath(HOME)]: JSON.stringify({ editor: "vim" }) })
    setEditorConfig(HOME, { command: "cursor" }, m.fsx)
    expect(JSON.parse(m.files.get(userConfigPath(HOME))!)).toEqual({
      editor: { command: "cursor" },
    })
  })

  it("merges into an existing editor object, preserving other keys", () => {
    const m = memFs({
      [userConfigPath(HOME)]: JSON.stringify({ editor: { command: "code", args: ["--wait"] } }),
    })
    setEditorConfig(HOME, { command: "cursor" }, m.fsx)
    expect(JSON.parse(m.files.get(userConfigPath(HOME))!)).toEqual({
      editor: { command: "cursor", args: ["--wait"] },
    })
  })

  it("validates the patch against the schema (bad gotoFormat)", () => {
    expect(() => setEditorConfig(HOME, { gotoFormat: "emacs" as never }, memFs().fsx)).toThrow()
  })
})

describe("setPluginToolsConfig", () => {
  it("writes pluginTools:true into a fresh config", () => {
    const m = memFs()
    const target = setPluginToolsConfig(HOME, true, m.fsx)
    expect(target).toBe(userConfigPath(HOME))
    expect(JSON.parse(m.files.get(target)!)).toEqual({ pluginTools: true })
  })

  it("writes pluginTools:false, preserving other keys", () => {
    const m = memFs({
      [userConfigPath(HOME)]: JSON.stringify({ provider: "openai", pluginTools: true }),
    })
    setPluginToolsConfig(HOME, false, m.fsx)
    expect(JSON.parse(m.files.get(userConfigPath(HOME))!)).toEqual({
      provider: "openai",
      pluginTools: false,
    })
  })

  it("does not clobber the theme when toggling pluginTools", () => {
    const m = memFs({
      [userConfigPath(HOME)]: JSON.stringify({ provider: "openai", theme: "dark" }),
    })
    setPluginToolsConfig(HOME, true, m.fsx)
    expect(JSON.parse(m.files.get(userConfigPath(HOME))!)).toEqual({
      provider: "openai",
      theme: "dark",
      pluginTools: true,
    })
  })
})

describe("setBuiltinTools", () => {
  it("merges a builtinTools patch into a fresh config", () => {
    const m = memFs()
    setBuiltinTools(HOME, { git: false }, m.fsx)
    expect(JSON.parse(m.files.get(userConfigPath(HOME))!)).toEqual({ builtinTools: { git: false } })
  })

  it("merges into existing builtinTools, preserving other toggles", () => {
    const m = memFs({
      [userConfigPath(HOME)]: JSON.stringify({
        provider: "openai",
        builtinTools: { git: true, lsp: false },
      }),
    })
    setBuiltinTools(HOME, { lsp: true }, m.fsx)
    expect(JSON.parse(m.files.get(userConfigPath(HOME))!)).toEqual({
      provider: "openai",
      builtinTools: { git: true, lsp: true },
    })
  })

  it("rejects an unknown builtin tool key", () => {
    expect(() => setBuiltinTools(HOME, { bogus: true } as never, memFs().fsx)).toThrow()
  })
})

describe("setBooleanFlag", () => {
  it("writes each allowed boolean flag", () => {
    for (const key of ["webTools", "skillTool", "slashCommandTool", "externalSkills"] as const) {
      const m = memFs()
      setBooleanFlag(HOME, key, false, m.fsx)
      expect(JSON.parse(m.files.get(userConfigPath(HOME))!)).toEqual({ [key]: false })
    }
  })

  it("preserves other keys when toggling a flag", () => {
    const m = memFs({
      [userConfigPath(HOME)]: JSON.stringify({ provider: "openai", theme: "dark" }),
    })
    setBooleanFlag(HOME, "webTools", false, m.fsx)
    expect(JSON.parse(m.files.get(userConfigPath(HOME))!)).toEqual({
      provider: "openai",
      theme: "dark",
      webTools: false,
    })
  })

  it("rejects a non-boolean flag key", () => {
    expect(() => setBooleanFlag(HOME, "provider" as never, true, memFs().fsx)).toThrow(
      /unknown boolean flag/
    )
  })

  it("writes the on-by-default flags (autoCompact/terminalTitle/showActiveSkills)", () => {
    for (const key of ["autoCompact", "terminalTitle", "showActiveSkills"] as const) {
      const m = memFs()
      setBooleanFlag(HOME, key, false, m.fsx)
      expect(JSON.parse(m.files.get(userConfigPath(HOME))!)).toEqual({ [key]: false })
    }
  })
})

describe("setNumberConfig", () => {
  it("writes each numeric key with a validated value", () => {
    const cases: [Parameters<typeof setNumberConfig>[1], number][] = [
      ["autoCompactThreshold", 0.9],
      ["streamIdleTimeoutMs", 120000],
      ["aiSdkMaxSteps", 512],
      ["toolExecutionTimeoutMs", 0],
      ["subagentStreamIdleTimeoutMs", 600000],
      ["subagentMaxDepth", 3],
    ]
    for (const [key, value] of cases) {
      const m = memFs()
      const target = setNumberConfig(HOME, key, value, m.fsx)
      expect(target).toBe(userConfigPath(HOME))
      expect(JSON.parse(m.files.get(target)!)).toEqual({ [key]: value })
    }
  })

  it("preserves other keys when setting a numeric knob", () => {
    const m = memFs({
      [userConfigPath(HOME)]: JSON.stringify({ provider: "openai", theme: "dark" }),
    })
    setNumberConfig(HOME, "aiSdkMaxSteps", 128, m.fsx)
    expect(JSON.parse(m.files.get(userConfigPath(HOME))!)).toEqual({
      provider: "openai",
      theme: "dark",
      aiSdkMaxSteps: 128,
    })
  })

  it("rejects an unknown numeric key", () => {
    expect(() => setNumberConfig(HOME, "provider" as never, 1, memFs().fsx)).toThrow(
      /unknown numeric key/
    )
  })

  it("rejects a non-integer millisecond value", () => {
    expect(() => setNumberConfig(HOME, "streamIdleTimeoutMs", 12.5, memFs().fsx)).toThrow()
  })
})

describe("setClipboardConfig", () => {
  it("writes a clipboard object into a fresh config", () => {
    const m = memFs()
    setClipboardConfig(HOME, { osc52: "always" }, m.fsx)
    expect(JSON.parse(m.files.get(userConfigPath(HOME))!)).toEqual({
      clipboard: { osc52: "always" },
    })
  })

  it("merges into an existing clipboard object, preserving other keys", () => {
    const m = memFs({
      [userConfigPath(HOME)]: JSON.stringify({ clipboard: { osc52: "auto", osc52MaxBytes: 1024 } }),
    })
    setClipboardConfig(HOME, { osc52MaxBytes: 2048 }, m.fsx)
    expect(JSON.parse(m.files.get(userConfigPath(HOME))!)).toEqual({
      clipboard: { osc52: "auto", osc52MaxBytes: 2048 },
    })
  })

  it("validates the patch against the schema (bad osc52 mode)", () => {
    expect(() => setClipboardConfig(HOME, { osc52: "sometimes" as never }, memFs().fsx)).toThrow()
  })
})

describe("setStringArrayConfig", () => {
  it("writes a skillDirs array", () => {
    const m = memFs()
    setStringArrayConfig(HOME, "skillDirs", ["/a", "/b"], m.fsx)
    expect(JSON.parse(m.files.get(userConfigPath(HOME))!)).toEqual({ skillDirs: ["/a", "/b"] })
  })

  it("clears the key when given an empty array", () => {
    const m = memFs({
      [userConfigPath(HOME)]: JSON.stringify({ provider: "openai", allowedTools: ["read"] }),
    })
    setStringArrayConfig(HOME, "allowedTools", [], m.fsx)
    expect(JSON.parse(m.files.get(userConfigPath(HOME))!)).toEqual({ provider: "openai" })
  })

  it("rejects a non-array key", () => {
    expect(() => setStringArrayConfig(HOME, "provider" as never, [], memFs().fsx)).toThrow(
      /unknown array key/
    )
  })
})

describe("setBuiltinHookOverride", () => {
  it("writes a single hook override into a fresh config", () => {
    const m = memFs()
    setBuiltinHookOverride(HOME, "pii-safety-guard", false, m.fsx)
    expect(JSON.parse(m.files.get(userConfigPath(HOME))!)).toEqual({
      builtinHookOverrides: { "pii-safety-guard": false },
    })
  })

  it("merges into existing overrides, preserving other ids", () => {
    const m = memFs({
      [userConfigPath(HOME)]: JSON.stringify({
        builtinHookOverrides: { "auto-context-loader": true },
      }),
    })
    setBuiltinHookOverride(HOME, "cost-quota-guard", false, m.fsx)
    expect(JSON.parse(m.files.get(userConfigPath(HOME))!)).toEqual({
      builtinHookOverrides: { "auto-context-loader": true, "cost-quota-guard": false },
    })
  })
})

describe("setCustomTheme", () => {
  it("writes the theme file under themes/<slug>.json", () => {
    const m = memFs()
    const target = setCustomTheme(
      HOME,
      "mine",
      { base: { accent: "#112233" }, overrides: { heading2: "#445566" } },
      m.fsx
    )
    expect(target).toBe(customThemePath(HOME, "mine"))
    expect(JSON.parse(m.files.get(target)!)).toEqual({
      base: { accent: "#112233" },
      overrides: { heading2: "#445566" },
    })
  })

  it("omits an empty overrides object", () => {
    const m = memFs()
    const target = setCustomTheme(HOME, "plain", { base: "dark" }, m.fsx)
    expect(JSON.parse(m.files.get(target)!)).toEqual({ base: "dark" })
  })
})

describe("setRenderConfig", () => {
  it("writes a render object into a fresh config", () => {
    const m = memFs()
    setRenderConfig(HOME, { fileLineNumbers: false }, m.fsx)
    expect(JSON.parse(m.files.get(userConfigPath(HOME))!)).toEqual({
      render: { fileLineNumbers: false },
    })
  })

  it("merges into an existing render object, preserving other prefs", () => {
    const m = memFs({
      [userConfigPath(HOME)]: JSON.stringify({
        provider: "openai",
        render: { syntaxHighlightInline: false, toolResultMaxLines: 20 },
      }),
    })
    setRenderConfig(HOME, { toolResultMaxLines: 60 }, m.fsx)
    expect(JSON.parse(m.files.get(userConfigPath(HOME))!)).toEqual({
      provider: "openai",
      render: { syntaxHighlightInline: false, toolResultMaxLines: 60 },
    })
  })

  it("rejects an out-of-range numeric pref", () => {
    expect(() => setRenderConfig(HOME, { toolResultMaxLines: 0 }, memFs().fsx)).toThrow()
  })
})

describe("setKeybindings", () => {
  it("writes a keybindings map into a fresh config", () => {
    const m = memFs()
    setKeybindings(HOME, { inspect: "ctrl+g" }, m.fsx)
    expect(JSON.parse(m.files.get(userConfigPath(HOME))!)).toEqual({
      keybindings: { inspect: "ctrl+g" },
    })
  })

  it("merges into existing bindings, preserving other ids", () => {
    const m = memFs({
      [userConfigPath(HOME)]: JSON.stringify({ keybindings: { inspect: "ctrl+g" } }),
    })
    setKeybindings(HOME, { verboseToggle: "ctrl+o" }, m.fsx)
    expect(JSON.parse(m.files.get(userConfigPath(HOME))!)).toEqual({
      keybindings: { inspect: "ctrl+g", verboseToggle: "ctrl+o" },
    })
  })

  it("deletes an override when given null (reset to default)", () => {
    const m = memFs({
      [userConfigPath(HOME)]: JSON.stringify({
        keybindings: { inspect: "ctrl+g", verboseToggle: "ctrl+o" },
      }),
    })
    setKeybindings(HOME, { inspect: null }, m.fsx)
    expect(JSON.parse(m.files.get(userConfigPath(HOME))!)).toEqual({
      keybindings: { verboseToggle: "ctrl+o" },
    })
  })

  it("clears the keybindings key entirely when the last override is removed", () => {
    const m = memFs({
      [userConfigPath(HOME)]: JSON.stringify({
        provider: "openai",
        keybindings: { inspect: "ctrl+g" },
      }),
    })
    setKeybindings(HOME, { inspect: null }, m.fsx)
    expect(JSON.parse(m.files.get(userConfigPath(HOME))!)).toEqual({ provider: "openai" })
  })
})

describe("setSubagentModel", () => {
  it("writes a new subagentModels entry", () => {
    const m = memFs()
    const target = setSubagentModel(
      HOME,
      "reviewer",
      { provider: "anthropic", model: "sonnet" },
      m.fsx
    )
    expect(JSON.parse(m.files.get(target)!)).toEqual({
      subagentModels: { reviewer: { provider: "anthropic", model: "sonnet" } },
    })
  })

  it("accepts a model-only override (no provider)", () => {
    const m = memFs()
    setSubagentModel(HOME, "reviewer", { model: "gpt-4o" }, m.fsx)
    expect(JSON.parse(m.files.get(userConfigPath(HOME))!)).toEqual({
      subagentModels: { reviewer: { model: "gpt-4o" } },
    })
  })

  it("merges with an existing map, preserving other agents", () => {
    const m = memFs({
      [userConfigPath(HOME)]: JSON.stringify({
        provider: "openai",
        subagentModels: { a: { model: "x" } },
      }),
    })
    setSubagentModel(HOME, "b", { model: "y" }, m.fsx)
    expect(JSON.parse(m.files.get(userConfigPath(HOME))!)).toEqual({
      provider: "openai",
      subagentModels: { a: { model: "x" }, b: { model: "y" } },
    })
  })

  it("deletes one entry when override is null, keeping the rest", () => {
    const m = memFs({
      [userConfigPath(HOME)]: JSON.stringify({
        subagentModels: { a: { model: "x" }, b: { model: "y" } },
      }),
    })
    setSubagentModel(HOME, "a", null, m.fsx)
    expect(JSON.parse(m.files.get(userConfigPath(HOME))!)).toEqual({
      subagentModels: { b: { model: "y" } },
    })
  })

  it("clears the subagentModels key entirely when the last entry is removed", () => {
    const m = memFs({
      [userConfigPath(HOME)]: JSON.stringify({
        provider: "openai",
        subagentModels: { a: { model: "x" } },
      }),
    })
    setSubagentModel(HOME, "a", null, m.fsx)
    expect(JSON.parse(m.files.get(userConfigPath(HOME))!)).toEqual({ provider: "openai" })
  })

  it("rejects an empty override (no provider or model)", () => {
    expect(() => setSubagentModel(HOME, "a", {} as never, memFs().fsx)).toThrow()
  })

  it("rejects a blank agent id", () => {
    expect(() => setSubagentModel(HOME, "  ", { model: "x" }, memFs().fsx)).toThrow(
      /id is required/
    )
  })
})

describe("setGitWorkflowConfig", () => {
  it("writes a git patch into a fresh config", () => {
    const { fsx, files } = memFs()
    setGitWorkflowConfig(HOME, { protectedBranches: ["master", "main", "dev"] }, fsx)
    const written = JSON.parse(files.get(userConfigPath(HOME))!)
    expect(written.git).toEqual({ protectedBranches: ["master", "main", "dev"] })
  })

  it("merges into an existing git object, preserving other keys", () => {
    const { fsx, files } = memFs({
      [userConfigPath(HOME)]: JSON.stringify({ git: { baseBranch: "dev" } }),
    })
    setGitWorkflowConfig(HOME, { coauthorTrailer: false }, fsx)
    const written = JSON.parse(files.get(userConfigPath(HOME))!)
    expect(written.git).toEqual({ baseBranch: "dev", coauthorTrailer: false })
  })

  it("clears a key when the patch sets it to undefined", () => {
    const { fsx, files } = memFs({
      [userConfigPath(HOME)]: JSON.stringify({ git: { baseBranch: "dev", prFooter: false } }),
    })
    setGitWorkflowConfig(HOME, { baseBranch: undefined }, fsx)
    const written = JSON.parse(files.get(userConfigPath(HOME))!)
    expect(written.git).toEqual({ prFooter: false })
  })

  it("drops the git key entirely when the last entry is cleared", () => {
    const { fsx, files } = memFs({
      [userConfigPath(HOME)]: JSON.stringify({ git: { baseBranch: "dev" } }),
    })
    setGitWorkflowConfig(HOME, { baseBranch: undefined }, fsx)
    const written = JSON.parse(files.get(userConfigPath(HOME))!)
    expect(written.git).toBeUndefined()
  })

  it("rejects a patch the schema refuses (empty branch name)", () => {
    const { fsx } = memFs()
    expect(() => setGitWorkflowConfig(HOME, { protectedBranches: [""] }, fsx)).toThrow()
  })
})

describe("setLoggingConfig", () => {
  it("writes a new logging block into config.json", () => {
    const m = memFs()
    const target = setLoggingConfig(HOME, { fileLevel: "warn", mcpLogMaxKb: 4096 }, m.fsx)
    expect(target).toBe(userConfigPath(HOME))
    const written = JSON.parse(m.files.get(userConfigPath(HOME))!)
    expect(written.logging).toEqual({ fileLevel: "warn", mcpLogMaxKb: 4096 })
  })

  it("merges over an existing logging block", () => {
    const m = memFs({
      [userConfigPath(HOME)]: JSON.stringify({
        logging: { fileLevel: "debug", crashLogMaxKb: 512 },
      }),
    })
    setLoggingConfig(HOME, { fileLevel: "error" }, m.fsx)
    const written = JSON.parse(m.files.get(userConfigPath(HOME))!)
    expect(written.logging).toEqual({ fileLevel: "error", crashLogMaxKb: 512 })
  })

  it("drops keys cleared to undefined and removes an empty block", () => {
    const m = memFs({
      [userConfigPath(HOME)]: JSON.stringify({ logging: { fileLevel: "debug" } }),
    })
    setLoggingConfig(HOME, { fileLevel: undefined }, m.fsx)
    const written = JSON.parse(m.files.get(userConfigPath(HOME))!)
    expect("logging" in written).toBe(false)
  })

  it("rejects a value the schema refuses (rotation size below the floor)", () => {
    const m = memFs()
    expect(() => setLoggingConfig(HOME, { mcpLogMaxKb: 1 }, m.fsx)).toThrow()
  })
})

describe("setProviderExperimentalAgentSdk (ADR-0090 Phase 4)", () => {
  it("writes the explicit opt-in flag for one provider and clears it on disable", () => {
    const m = memFs()
    const target = setProviderExperimentalAgentSdk(HOME, "my-relay", true, m.fsx)
    let written = JSON.parse(m.files.get(target)!)
    expect(written.providers["my-relay"].experimentalAgentSdk).toBe(true)

    setProviderExperimentalAgentSdk(HOME, "my-relay", false, m.fsx)
    written = JSON.parse(m.files.get(target)!)
    expect("experimentalAgentSdk" in (written.providers["my-relay"] ?? {})).toBe(false)
  })

  it("preserves the provider's other fields", () => {
    const m = memFs({
      [userConfigPath(HOME)]: JSON.stringify({
        providers: { "my-relay": { baseURL: "https://relay.example/v1", model: "m-1" } },
      }),
    })
    setProviderExperimentalAgentSdk(HOME, "my-relay", true, m.fsx)
    const written = JSON.parse(m.files.get(userConfigPath(HOME))!)
    expect(written.providers["my-relay"]).toMatchObject({
      baseURL: "https://relay.example/v1",
      model: "m-1",
      experimentalAgentSdk: true,
    })
  })
})
