import { getPluginManager } from "./manager"

describe("getPluginManager", () => {
  it("returns a singleton across calls", () => {
    const a = getPluginManager()
    const b = getPluginManager()
    expect(a).toBe(b)
  })

  it("registers and lists plugins", () => {
    const mgr = getPluginManager()
    const dispose = mgr.register("p1", { value: 1 })
    expect(mgr.list()).toContain("p1")
    dispose()
    expect(mgr.list()).not.toContain("p1")
  })

  it("unregister removes a plugin", () => {
    const mgr = getPluginManager()
    mgr.register("u1", {})
    mgr.unregister("u1")
    expect(mgr.list()).not.toContain("u1")
  })

  it("enable / disable / unload are no-ops that resolve", async () => {
    const mgr = getPluginManager()
    mgr.register("z", {})
    await expect(mgr.enablePlugin("z")).resolves.toBeUndefined()
    await expect(mgr.disablePlugin("z")).resolves.toBeUndefined()
    await mgr.unloadPlugin("z")
    expect(mgr.list()).not.toContain("z")
  })
})
