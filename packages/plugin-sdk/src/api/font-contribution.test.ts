import * as sdk from "./font-contribution"
import type {
  ApplyPluginFontsArgs,
  ApplyPluginFontsResult,
  FontEntry,
  FontSource,
  PluginFontContribution,
  PluginFontFile,
  ResolveAssetFn,
} from "./font-contribution"

describe("plugin-sdk api/font-contribution", () => {
  it("exposes the authoring helper, font bridge, and font registry", () => {
    expect(typeof sdk.defineFontContribution).toBe("function")
    expect(typeof sdk.applyPluginFonts).toBe("function")
    expect(typeof sdk.revertPluginFonts).toBe("function")
    expect(typeof sdk.detectFontKind).toBe("function")
    expect(typeof sdk.cssFormatHintFor).toBe("function")
    expect(typeof sdk.buildFontFaceRule).toBe("function")
    expect(typeof sdk.setSystemFonts).toBe("function")
    expect(typeof sdk.registerPluginFont).toBe("function")
    expect(typeof sdk.unregisterPluginFontsByPlugin).toBe("function")
    expect(typeof sdk.listFonts).toBe("function")
    expect(typeof sdk.subscribeFonts).toBe("function")
    expect(typeof sdk.fontRegistrySnapshot).toBe("function")
    expect(typeof sdk.findFont).toBe("function")
  })

  it("re-exports font contribution, bridge, and registry types", () => {
    const assertTypes = <
      _T extends
        | PluginFontContribution
        | PluginFontFile
        | ApplyPluginFontsArgs
        | ApplyPluginFontsResult
        | ResolveAssetFn
        | FontEntry
        | FontSource,
    >(): void => undefined

    expect(assertTypes).toBeDefined()
  })
})
