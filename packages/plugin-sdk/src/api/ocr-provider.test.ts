import * as sdk from "./ocr-provider"
import type {
  OcrProvider,
  PluginOcrAPI,
  PluginOcrProviderDef,
  PluginOcrProviderFactory,
  PluginOcrProviderFactoryContext,
  PluginOcrRegistration,
} from "./ocr-provider"

describe("plugin-sdk api/ocr-provider", () => {
  it("exposes portable authoring and result helpers", () => {
    expect(typeof sdk.defineOcrProvider).toBe("function")
    expect(typeof sdk.buildOcrResultPart).toBe("function")
    expect(typeof sdk.parseOcrArgs).toBe("function")
    expect(typeof sdk.createNullOcrCache).toBe("function")
    expect(typeof sdk.OcrError).toBe("function")
    expect(sdk.buildOcrSecurityEnvelope({ providerId: "mock" } as never, "screen")).toMatchObject({
      provenance: { kind: "ocr", providerId: "mock", sourceKind: "screen" },
      security: { untrusted: true, pii: "unreviewed" },
    })
  })

  it("re-exports OCR provider contribution, plugin API, and registry types", () => {
    const assertTypes = <
      _T extends
        | PluginOcrProviderDef
        | PluginOcrProviderFactory
        | PluginOcrProviderFactoryContext
        | PluginOcrRegistration
        | PluginOcrAPI
        | OcrProvider,
    >(): void => undefined

    expect(assertTypes).toBeDefined()
  })
})
