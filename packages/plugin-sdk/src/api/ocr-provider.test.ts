import * as sdk from "./ocr-provider"
import type {
  OcrProvider,
  OcrRegistry,
  PluginOcrAPI,
  PluginOcrProviderDef,
  PluginOcrProviderFactory,
  PluginOcrProviderFactoryContext,
  PluginOcrRegistration,
} from "./ocr-provider"

describe("plugin-sdk api/ocr-provider", () => {
  it("exposes the authoring helper, manifest bridge, plugin API, and shared OCR registry", () => {
    expect(typeof sdk.defineOcrProvider).toBe("function")
    expect(typeof sdk.registerOcrProvidersForPlugin).toBe("function")
    expect(typeof sdk.unregisterOcrProvidersForPlugin).toBe("function")
    expect(typeof sdk.createOcrAPI).toBe("function")
    expect(typeof sdk.clearOcrProvidersForPlugin).toBe("function")
    expect(typeof sdk.registerOcrProvider).toBe("function")
    expect(typeof sdk.getSharedOcrRegistry).toBe("function")
    expect(typeof sdk.createOcrRegistry).toBe("function")
    expect(typeof sdk.shellAllows).toBe("function")
  })

  it("re-exports OCR provider contribution, plugin API, and registry types", () => {
    const assertTypes = <
      _T extends
        | PluginOcrProviderDef
        | PluginOcrProviderFactory
        | PluginOcrProviderFactoryContext
        | PluginOcrRegistration
        | PluginOcrAPI
        | OcrProvider
        | OcrRegistry,
    >(): void => undefined

    expect(assertTypes).toBeDefined()
  })
})
