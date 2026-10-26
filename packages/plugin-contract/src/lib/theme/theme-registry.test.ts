import {
  registerPluginTheme,
  unregisterPluginTheme,
  unregisterThemesByPlugin,
  getPluginTheme,
  listPluginThemes,
  subscribeThemeRegistry,
  __resetThemeRegistryForTesting,
  type PluginTheme,
} from "./theme-registry"

const fixture = (overrides: Partial<PluginTheme> = {}): PluginTheme => ({
  id: "p.dark",
  name: "Plugin Dark",
  variables: { "--background": "oklch(0.1 0 0)" },
  variant: "dark",
  source: "plugin",
  pluginId: "p",
  ...overrides,
})

afterEach(() => {
  __resetThemeRegistryForTesting()
})

describe("theme registry", () => {
  it("register / get round-trips a theme", () => {
    registerPluginTheme(fixture())
    expect(getPluginTheme("p.dark")?.name).toBe("Plugin Dark")
  })

  it("rejects themes without an id", () => {
    expect(() => registerPluginTheme(fixture({ id: "" }))).toThrow(/id is required/)
  })

  it("re-registering the same id reports replaced=true", () => {
    registerPluginTheme(fixture())
    expect(registerPluginTheme(fixture({ name: "Renamed" })).replaced).toBe(true)
    expect(getPluginTheme("p.dark")?.name).toBe("Renamed")
  })

  it("unregisterPluginTheme drops a single entry", () => {
    registerPluginTheme(fixture())
    expect(unregisterPluginTheme("p.dark")).toBe(true)
    expect(unregisterPluginTheme("p.dark")).toBe(false)
  })

  it("unregisterThemesByPlugin only removes that plugin's themes", () => {
    registerPluginTheme(fixture({ id: "p.a", pluginId: "p" }))
    registerPluginTheme(fixture({ id: "p.b", pluginId: "p" }))
    registerPluginTheme(fixture({ id: "q.a", pluginId: "q" }))
    expect(unregisterThemesByPlugin("p")).toBe(2)
    expect(getPluginTheme("p.a")).toBeUndefined()
    expect(getPluginTheme("p.b")).toBeUndefined()
    expect(getPluginTheme("q.a")).toBeDefined()
  })

  it("listPluginThemes returns every registered theme", () => {
    registerPluginTheme(fixture({ id: "a" }))
    registerPluginTheme(fixture({ id: "b" }))
    expect(
      listPluginThemes()
        .map((t) => t.id)
        .sort()
    ).toEqual(["a", "b"])
  })

  describe("subscribe + snapshot stability", () => {
    it("notifies subscribers on register / unregister / replace / unregisterByPlugin", () => {
      const calls: number[] = []
      const unsubscribe = subscribeThemeRegistry(() => calls.push(calls.length))

      registerPluginTheme(fixture({ id: "a" })) // 1
      registerPluginTheme(fixture({ id: "a" })) // 2 (replace)
      registerPluginTheme(fixture({ id: "b", pluginId: "p" })) // 3
      unregisterPluginTheme("a") // 4
      unregisterThemesByPlugin("p") // 5

      expect(calls.length).toBe(5)
      unsubscribe()
    })

    it("does not notify when unregister is a no-op", () => {
      const fn = jest.fn()
      const unsubscribe = subscribeThemeRegistry(fn)
      expect(unregisterPluginTheme("missing")).toBe(false)
      expect(unregisterThemesByPlugin("missing")).toBe(0)
      expect(fn).not.toHaveBeenCalled()
      unsubscribe()
    })

    it("returned unsubscribe stops further notifications", () => {
      const fn = jest.fn()
      const unsubscribe = subscribeThemeRegistry(fn)
      unsubscribe()
      registerPluginTheme(fixture())
      expect(fn).not.toHaveBeenCalled()
    })

    it("isolates listener errors from other subscribers", () => {
      const ok = jest.fn()
      const bad = jest.fn(() => {
        throw new Error("boom")
      })
      const u1 = subscribeThemeRegistry(bad)
      const u2 = subscribeThemeRegistry(ok)
      registerPluginTheme(fixture())
      expect(bad).toHaveBeenCalled()
      expect(ok).toHaveBeenCalled()
      u1()
      u2()
    })

    it("returns a stable snapshot reference between mutations", () => {
      registerPluginTheme(fixture())
      const snap1 = listPluginThemes()
      const snap2 = listPluginThemes()
      expect(snap1).toBe(snap2)
    })

    it("invalidates the snapshot on mutation", () => {
      registerPluginTheme(fixture({ id: "a" }))
      const snap1 = listPluginThemes()
      registerPluginTheme(fixture({ id: "b" }))
      const snap2 = listPluginThemes()
      expect(snap1).not.toBe(snap2)
      expect(snap2.length).toBe(2)
    })
  })
})
