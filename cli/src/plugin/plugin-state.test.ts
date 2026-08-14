/**
 * @jest-environment node
 */
import {
  pluginStatePath,
  createCliPluginLifecycleStateAdapter,
  readPluginState,
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
    expect(readPluginState("/home", fs).lifecycle.p1.intent).toBe("enabled")
  })

  it("migrates legacy disabled entries into canonical intent on first read", async () => {
    const fs = memFs({ [pluginStatePath("/home")]: JSON.stringify({ disabled: ["legacy"] }) })
    const adapter = createCliPluginLifecycleStateAdapter("/home", fs)

    await expect(adapter.read("legacy")).resolves.toMatchObject({
      intent: "disabled",
      actual: "inactive",
      revision: 0,
    })
  })

  it("persists monotonic lifecycle revisions and rejects stale transitions", async () => {
    const fs = memFs()
    const adapter = createCliPluginLifecycleStateAdapter("/home", fs)

    const first = await adapter.write("p1", 0, { intent: "disabled", actual: "stopping" })
    await expect(adapter.write("p1", 0, { actual: "active" })).rejects.toThrow(/state changed/i)
    const second = await adapter.write("p1", first.revision, { actual: "inactive" })

    expect(second.revision).toBeGreaterThan(first.revision)
    expect(readDisabledPlugins("/home", fs)).toEqual(new Set(["p1"]))
  })
})
