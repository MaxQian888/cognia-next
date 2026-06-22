import {
  __resetProviderRegistryForTesting,
  getDynamicProviders,
  isGenuineOpenAiEndpoint,
  registerProviderDefinition,
} from "./index"

describe("provider-core package barrel", () => {
  beforeEach(() => {
    __resetProviderRegistryForTesting()
  })

  it("re-exports the provider client endpoint classifier", () => {
    expect(isGenuineOpenAiEndpoint(undefined)).toBe(true)
    expect(isGenuineOpenAiEndpoint("https://api.openai.com/v1")).toBe(true)
    expect(isGenuineOpenAiEndpoint("https://openrouter.ai/api/v1")).toBe(false)
    expect(isGenuineOpenAiEndpoint("not a url")).toBe(false)
  })

  it("re-exports dynamic provider registry helpers", () => {
    registerProviderDefinition(
      {
        id: "plugin-provider",
        name: "Plugin Provider",
        type: "cloud",
        protocol: "openai",
        apiKeyRequired: true,
        baseURLRequired: false,
        defaultModel: "plugin-model",
        defaultEnabled: true,
        category: "experimental",
        models: [
          {
            id: "plugin-model",
            name: "Plugin Model",
            contextLength: 128000,
            supportsTools: true,
            supportsVision: false,
            supportsAudio: false,
            supportsVideo: false,
            supportsStreaming: true,
          },
        ],
      },
      "plugin"
    )

    expect(getDynamicProviders()["plugin-provider"]).toMatchObject({
      id: "plugin-provider",
      defaultModel: "plugin-model",
    })
  })
})
