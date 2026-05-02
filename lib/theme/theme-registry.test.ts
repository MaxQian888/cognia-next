import {
  registerPluginTheme,
  unregisterPluginTheme,
  unregisterThemesByPlugin,
  getPluginTheme,
  listPluginThemes,
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
})
