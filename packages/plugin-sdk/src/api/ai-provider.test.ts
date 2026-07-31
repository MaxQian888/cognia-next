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
  it("exposes the authoring helper, manifest bridge, and plugin AI provider API", () => {
    expect(typeof sdk.defineAiProvider).toBe("function")
    expect(typeof sdk.registerAiProvidersForPlugin).toBe("function")
    expect(typeof sdk.unregisterAiProvidersForPlugin).toBe("function")
    expect(typeof sdk.createAIProviderAPI).toBe("function")
    expect(typeof sdk.getCustomAIProviders).toBe("function")
    expect(typeof sdk.clearCustomAIProviders).toBe("function")
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
