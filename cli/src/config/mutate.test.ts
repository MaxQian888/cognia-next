/**
 * @jest-environment node
 */
import {
  setConfigValue,
  setMascotConfig,
  setProviderModel,
  setStatusBarConfig,
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
