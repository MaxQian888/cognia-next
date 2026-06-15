/**
 * @jest-environment node
 */
import {
  customThemePath,
  setBooleanFlag,
  setBuiltinHookOverride,
  setBuiltinTools,
  setConfigValue,
  setCustomTheme,
  setKeybindings,
  setMascotConfig,
  setPluginToolsConfig,
  setProviderModel,
  setRenderConfig,
  setStatusBarConfig,
  setStringArrayConfig,
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
