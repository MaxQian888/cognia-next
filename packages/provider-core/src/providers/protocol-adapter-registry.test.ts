import {
  __resetProtocolAdaptersForTesting,
  getCodeAdapterExecutor,
  getProtocolAdapter,
  listProtocolAdapters,
  type CodeProtocolAdapterFactory,
  type PluginProtocolAdapterDef,
  registerCodeAdapterExecutor,
  registerProtocolAdapter,
  unregisterCodeAdapterExecutorsByPlugin,
  unregisterProtocolAdapter,
  unregisterProtocolAdaptersByPlugin,
} from "./protocol-adapter-registry"

const def = (id: string): PluginProtocolAdapterDef => ({
  id,
  label: `Adapter ${id}`,
  spec: {
    kind: "openai-compatible-variant",
    urlTemplate: "{baseURL}/chat",
    responsePaths: { textDelta: "choices[0].delta.content" },
  },
})

describe("protocol-adapter-registry", () => {
  afterEach(() => __resetProtocolAdaptersForTesting())

  it("registers and resolves a plugin adapter", () => {
    expect(registerProtocolAdapter(def("p1:wire"), { pluginId: "p1" })).toBe(true)
    expect(getProtocolAdapter("p1:wire")?.label).toBe("Adapter p1:wire")
  })

  it("refuses reserved/built-in protocol ids (both naming families)", () => {
    for (const reserved of ["openai", "anthropic", "gemini", "google", "mistral", "cohere"]) {
      expect(registerProtocolAdapter(def(reserved))).toBe(false)
      expect(getProtocolAdapter(reserved)).toBeUndefined()
    }
  })

  it("unregisters by id and by plugin", () => {
    registerProtocolAdapter(def("p1:a"), { pluginId: "p1" })
    registerProtocolAdapter(def("p1:b"), { pluginId: "p1" })
    registerProtocolAdapter(def("p2:c"), { pluginId: "p2" })
    expect(unregisterProtocolAdapter("p1:a")).toBe(true)
    expect(unregisterProtocolAdaptersByPlugin("p1")).toBe(1)
    expect(getProtocolAdapter("p2:c")).toBeDefined()
    expect(getProtocolAdapter("p1:b")).toBeUndefined()
  })

  it("lists adapters with plugin attribution", () => {
    registerProtocolAdapter(def("p1:wire"), { pluginId: "p1" })
    expect(listProtocolAdapters()).toEqual([
      { id: "p1:wire", label: "Adapter p1:wire", pluginId: "p1" },
    ])
  })

  it("keeps the first plugin registration when another plugin reuses an id", () => {
    registerProtocolAdapter(def("shared:wire"), { pluginId: "p1" })

    expect(
      registerProtocolAdapter({ ...def("shared:wire"), label: "Second" }, { pluginId: "p2" })
    ).toBe(true)
    expect(getProtocolAdapter("shared:wire")?.label).toBe("Adapter shared:wire")
  })

  describe("code-adapter executors", () => {
    const factory: CodeProtocolAdapterFactory = () => ({
      stream: async function* () {},
    })

    it("registers and resolves a code executor", () => {
      registerCodeAdapterExecutor("p1:code", factory, "p1")
      expect(getCodeAdapterExecutor("p1:code")).toBe(factory)
      expect(getCodeAdapterExecutor("missing")).toBeUndefined()
    })

    it("unregisters every executor of a plugin", () => {
      registerCodeAdapterExecutor("p1:a", factory, "p1")
      registerCodeAdapterExecutor("p1:b", factory, "p1")
      registerCodeAdapterExecutor("p2:c", factory, "p2")
      expect(unregisterCodeAdapterExecutorsByPlugin("p1")).toBe(2)
      expect(getCodeAdapterExecutor("p1:a")).toBeUndefined()
      expect(getCodeAdapterExecutor("p2:c")).toBe(factory)
    })

    it("__reset clears executors too", () => {
      registerCodeAdapterExecutor("p1:x", factory, "p1")
      __resetProtocolAdaptersForTesting()
      expect(getCodeAdapterExecutor("p1:x")).toBeUndefined()
    })
  })
})
