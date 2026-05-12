import {
  __resetProviderRegistryForTesting,
  getDynamicProviders,
  registerProviderDefinition,
  type ProviderDefinition,
} from "./provider-loader"

const baseDefinition: ProviderDefinition = {
  id: "test-id",
  name: "Test Provider",
  type: "cloud",
  protocol: "openai",
  apiKeyRequired: true,
  baseURLRequired: false,
  defaultModel: "test-model",
  defaultEnabled: false,
  category: "core",
  description: "test",
  models: [
    {
      id: "test-model",
      name: "Test Model",
      contextLength: 8192,
      supportsTools: true,
      supportsVision: false,
      supportsAudio: false,
      supportsVideo: false,
      supportsStreaming: true,
    },
  ],
}

describe("getDynamicProviders", () => {
  beforeEach(() => {
    __resetProviderRegistryForTesting()
  })

  it("returns an empty record when no providers are registered", () => {
    expect(getDynamicProviders()).toEqual({})
  })

  it("returns a single adapted provider after registration", () => {
    registerProviderDefinition(baseDefinition)
    const out = getDynamicProviders()
    expect(Object.keys(out)).toEqual(["test-id"])
    const cfg = out["test-id"]
    expect(cfg.id).toBe("test-id")
    expect(cfg.name).toBe("Test Provider")
    expect(cfg.type).toBe("cloud")
    expect(cfg.protocol).toBe("openai")
    expect(cfg.category).toBe("flagship")
    expect(cfg.models).toHaveLength(1)
    expect(cfg.models[0]).toMatchObject({
      id: "test-model",
      name: "Test Model",
      contextLength: 8192,
      supportsStreaming: true,
    })
  })

  it("maps google protocol to gemini", () => {
    registerProviderDefinition({ ...baseDefinition, id: "g", protocol: "google" })
    expect(getDynamicProviders().g.protocol).toBe("gemini")
  })

  it("maps mistral and cohere protocols to openai (OpenAI-compatible fallback)", () => {
    registerProviderDefinition({ ...baseDefinition, id: "m", protocol: "mistral" })
    registerProviderDefinition({ ...baseDefinition, id: "c", protocol: "cohere" })
    expect(getDynamicProviders().m.protocol).toBe("openai")
    expect(getDynamicProviders().c.protocol).toBe("openai")
  })

  it("maps anthropic protocol directly", () => {
    registerProviderDefinition({ ...baseDefinition, id: "a", protocol: "anthropic" })
    expect(getDynamicProviders().a.protocol).toBe("anthropic")
  })

  it("maps specialized and experimental categories to specialized", () => {
    registerProviderDefinition({ ...baseDefinition, id: "s", category: "specialized" })
    registerProviderDefinition({ ...baseDefinition, id: "e", category: "experimental" })
    expect(getDynamicProviders().s.category).toBe("specialized")
    expect(getDynamicProviders().e.category).toBe("specialized")
  })

  it("maps self-hosted type to local", () => {
    registerProviderDefinition({ ...baseDefinition, id: "sh", type: "self-hosted" })
    expect(getDynamicProviders().sh.type).toBe("local")
  })

  it("preserves multiple registered providers", () => {
    registerProviderDefinition({ ...baseDefinition, id: "p1" })
    registerProviderDefinition({ ...baseDefinition, id: "p2" })
    const out = getDynamicProviders()
    expect(Object.keys(out).sort()).toEqual(["p1", "p2"])
  })
})
