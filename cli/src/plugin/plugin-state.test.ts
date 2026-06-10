/**
 * @jest-environment node
 */
import {
  pluginStatePath,
  readDisabledPlugins,
  setPluginDisabled,
  type PluginStateFs,
} from "./plugin-state"

function memFs(seed: Record<string, string> = {}): PluginStateFs {
  const files = { ...seed }
  return {
    exists: (p) => p in files,
    readText: (p) => files[p],
    writeText: (p, data) => {
      files[p] = data
    },
  }
}

describe("plugin enable/disable state", () => {
  it("returns empty when no file exists", () => {
    expect(readDisabledPlugins("/home", memFs())).toEqual(new Set())
  })

  it("reads the disabled list", () => {
    const fs = memFs({ [pluginStatePath("/home")]: JSON.stringify({ disabled: ["a", "b"] }) })
    expect([...readDisabledPlugins("/home", fs)].sort()).toEqual(["a", "b"])
  })

  it("tolerates corrupt state", () => {
    const fs = memFs({ [pluginStatePath("/home")]: "nope" })
    expect(readDisabledPlugins("/home", fs)).toEqual(new Set())
  })

  it("adds then removes an id, persisting each change", () => {
    const fs = memFs()
    setPluginDisabled("/home", "p1", true, fs)
    expect(readDisabledPlugins("/home", fs).has("p1")).toBe(true)
    setPluginDisabled("/home", "p1", false, fs)
    expect(readDisabledPlugins("/home", fs).has("p1")).toBe(false)
  })
})
