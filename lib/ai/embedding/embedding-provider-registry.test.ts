import {
  registerEmbeddingProvider,
  unregisterEmbeddingProvider,
  unregisterProvidersByPlugin,
  getEmbeddingProvider,
  listEmbeddingProviders,
  __resetEmbeddingProvidersForTesting,
  type EmbeddingProvider,
} from "./embedding-provider-registry"

const fixture = (overrides: Partial<EmbeddingProvider> = {}): EmbeddingProvider => ({
  id: "p.openai",
  name: "Plugin OpenAI",
  generateEmbedding: async () => new Array(8).fill(0),
  source: "plugin",
  pluginId: "p",
  ...overrides,
})

afterEach(() => {
  __resetEmbeddingProvidersForTesting()
})

describe("embedding-provider registry", () => {
  it("register / get round-trips a provider", () => {
    registerEmbeddingProvider(fixture())
    expect(getEmbeddingProvider("p.openai")?.name).toBe("Plugin OpenAI")
  })

  it("rejects providers without an id", () => {
    expect(() => registerEmbeddingProvider(fixture({ id: "" }))).toThrow(/id is required/)
  })

  it("rejects providers without a generateEmbedding function", () => {
    expect(() =>
      registerEmbeddingProvider({
        id: "broken",
        name: "Broken",
        // @ts-expect-error intentional bad input
        generateEmbedding: 42,
      })
    ).toThrow(/generateEmbedding/)
  })

  it("re-registering the same id reports replaced=true", () => {
    registerEmbeddingProvider(fixture())
    expect(registerEmbeddingProvider(fixture({ name: "Renamed" })).replaced).toBe(true)
    expect(getEmbeddingProvider("p.openai")?.name).toBe("Renamed")
  })

  it("unregisterEmbeddingProvider drops a single entry", () => {
    registerEmbeddingProvider(fixture())
    expect(unregisterEmbeddingProvider("p.openai")).toBe(true)
    expect(unregisterEmbeddingProvider("p.openai")).toBe(false)
  })

  it("unregisterProvidersByPlugin only removes that plugin's providers", () => {
    registerEmbeddingProvider(fixture({ id: "a", pluginId: "p" }))
    registerEmbeddingProvider(fixture({ id: "b", pluginId: "p" }))
    registerEmbeddingProvider(fixture({ id: "c", pluginId: "q" }))
    expect(unregisterProvidersByPlugin("p")).toBe(2)
    expect(getEmbeddingProvider("a")).toBeUndefined()
    expect(getEmbeddingProvider("b")).toBeUndefined()
    expect(getEmbeddingProvider("c")).toBeDefined()
  })

  it("provider's generateEmbedding is callable through the registry", async () => {
    const fn = jest.fn(async () => [1, 2, 3])
    registerEmbeddingProvider(fixture({ generateEmbedding: fn }))
    const out = await getEmbeddingProvider("p.openai")!.generateEmbedding("hello")
    expect(out).toEqual([1, 2, 3])
    expect(fn).toHaveBeenCalledWith("hello")
  })

  it("listEmbeddingProviders returns every registered provider", () => {
    registerEmbeddingProvider(fixture({ id: "a" }))
    registerEmbeddingProvider(fixture({ id: "b" }))
    expect(
      listEmbeddingProviders()
        .map((p) => p.id)
        .sort()
    ).toEqual(["a", "b"])
  })
})
