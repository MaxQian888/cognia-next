import {
  registerPluginI18n,
  unregisterPluginI18n,
  getPluginI18nBundle,
  getMergedPluginMessages,
  lookupPluginMessage,
  subscribeToPluginI18n,
  getPluginI18nSnapshot,
  inflateFlatKeys,
  __resetPluginI18nForTesting,
} from "./plugin-i18n-registry"

afterEach(() => {
  __resetPluginI18nForTesting()
})

describe("plugin-i18n registry", () => {
  it("register / get round-trips a bundle", () => {
    registerPluginI18n({
      pluginId: "p",
      messages: { en: { "p.hello": "Hi" } },
    })
    expect(getPluginI18nBundle("p")?.messages.en?.["p.hello"]).toBe("Hi")
  })

  it("rejects bundles without pluginId", () => {
    expect(() => registerPluginI18n({ pluginId: "", messages: {} })).toThrow(/pluginId is required/)
  })

  it("re-registering the same plugin id reports replaced=true", () => {
    registerPluginI18n({ pluginId: "p", messages: { en: { x: "1" } } })
    const r = registerPluginI18n({ pluginId: "p", messages: { en: { x: "2" } } })
    expect(r.replaced).toBe(true)
    expect(getPluginI18nBundle("p")?.messages.en?.x).toBe("2")
  })

  it("unregisterPluginI18n drops a single entry", () => {
    registerPluginI18n({ pluginId: "p", messages: { en: {} } })
    expect(unregisterPluginI18n("p")).toBe(true)
    expect(unregisterPluginI18n("p")).toBe(false)
  })

  it("getMergedPluginMessages folds every bundle into a single locale map", () => {
    registerPluginI18n({
      pluginId: "p1",
      messages: { en: { a: "A1" }, "zh-CN": { a: "A1cn" } },
    })
    registerPluginI18n({
      pluginId: "p2",
      messages: { en: { b: "B2" } },
    })
    const merged = getMergedPluginMessages()
    expect(merged.en).toEqual({ a: "A1", b: "B2" })
    expect(merged["zh-CN"]).toEqual({ a: "A1cn" })
  })

  it("lookupPluginMessage finds a key in the first matching bundle", () => {
    registerPluginI18n({ pluginId: "p", messages: { en: { greet: "Hello" } } })
    expect(lookupPluginMessage("en", "greet")).toBe("Hello")
    expect(lookupPluginMessage("en", "missing")).toBeUndefined()
    expect(lookupPluginMessage("ja", "greet")).toBeUndefined()
  })

  it("subscribeToPluginI18n fires on register and unregister, and the snapshot version moves", () => {
    const observed: number[] = []
    const initial = getPluginI18nSnapshot()
    const unsubscribe = subscribeToPluginI18n(() => observed.push(getPluginI18nSnapshot()))
    registerPluginI18n({ pluginId: "p", messages: { en: { a: "A" } } })
    unregisterPluginI18n("p")
    unsubscribe()
    // Subsequent mutations after unsubscribe must not fire the listener.
    registerPluginI18n({ pluginId: "q", messages: { en: { b: "B" } } })
    expect(observed.length).toBe(2)
    expect(observed[0]).toBeGreaterThan(initial)
    expect(observed[1]).toBeGreaterThan(observed[0])
  })

  it("inflateFlatKeys expands dot-notation into the nested shape next-intl expects", () => {
    const nested = inflateFlatKeys({
      "panel.title": "Hi",
      "panel.body": "World",
      "deep.a.b.c": "x",
      flat: "y",
    })
    expect(nested).toEqual({
      panel: { title: "Hi", body: "World" },
      deep: { a: { b: { c: "x" } } },
      flat: "y",
    })
  })

  it("inflateFlatKeys never crashes on an empty input", () => {
    expect(inflateFlatKeys({})).toEqual({})
  })
})
