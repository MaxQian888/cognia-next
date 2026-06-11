/**
 * @jest-environment node
 */
import { setConfigValue, setStatusBarConfig, SETTABLE_KEYS, type ConfigMutateFs } from "./mutate"
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
    for (const key of SETTABLE_KEYS) {
      const value = key === "permissionMode" ? "default" : "v"
      expect(() => setConfigValue(HOME, key, value, memFs().fsx)).not.toThrow()
    }
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
