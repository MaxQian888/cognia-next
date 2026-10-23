import * as sdk from "./ai-provider"
import type {
  AIChatChunk,
  AIChatMessage,
  AIChatOptions,
  AIModel,
  AIProviderDefinition,
  AiProvidersBridgeError,
  AiProvidersBridgeOptions,
  AiProvidersBridgeResult,
  PluginAIProviderAPI,
  PluginAiProvider,
  PluginAiProviderDef,
  PluginAiProviderFactory,
  PluginAiProviderFactoryContext,
  PluginAiProviderRegistration,
} from "./ai-provider"

describe("plugin-sdk api/ai-provider", () => {
  it("exposes the authoring helper", () => {
    expect(typeof sdk.defineAiProvider).toBe("function")
  })

  it("keeps host wiring off the author surface (plugins reach it through ctx.ai)", () => {
    expect(sdk).not.toHaveProperty("registerAiProvidersForPlugin")
    expect(sdk).not.toHaveProperty("unregisterAiProvidersForPlugin")
    expect(sdk).not.toHaveProperty("createAIProviderAPI")
    expect(sdk).not.toHaveProperty("getCustomAIProviders")
    expect(sdk).not.toHaveProperty("clearCustomAIProviders")
  })

  it("re-exports provider manifest, bridge, and runtime API types", () => {
    const assertTypes = <
      _T extends
        | PluginAiProviderDef
        | PluginAiProvider
        | PluginAiProviderFactory
        | PluginAiProviderFactoryContext
        | PluginAiProviderRegistration
        | PluginAIProviderAPI
        | AIProviderDefinition
        | AIModel
        | AIChatMessage
        | AIChatOptions
        | AIChatChunk
        | AiProvidersBridgeOptions
        | AiProvidersBridgeResult
        | AiProvidersBridgeError,
    >(): void => undefined

    expect(assertTypes).toBeDefined()
  })
})
