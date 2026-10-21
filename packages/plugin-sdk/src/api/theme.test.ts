import * as sdk from "./theme"
import type {
  CustomTheme,
  PluginTheme,
  PluginThemeAPI,
  PluginThemeContribution,
  ThemeColors,
  ThemesBridgeRegisterResult,
} from "./theme"

describe("plugin-sdk api/theme", () => {
  it("exposes the authoring helper and the theme registry", () => {
    expect(typeof sdk.defineTheme).toBe("function")
    expect(typeof sdk.registerPluginTheme).toBe("function")
    expect(typeof sdk.unregisterPluginTheme).toBe("function")
    expect(typeof sdk.unregisterThemesByPlugin).toBe("function")
    expect(typeof sdk.getPluginTheme).toBe("function")
    expect(typeof sdk.listPluginThemes).toBe("function")
    expect(typeof sdk.subscribeThemeRegistry).toBe("function")
  })

  it("keeps host wiring off the author surface (plugins reach it through ctx.theme)", () => {
    expect(sdk).not.toHaveProperty("createThemeAPI")
    expect(sdk).not.toHaveProperty("clearCustomThemesForPluginContext")
    expect(sdk).not.toHaveProperty("getPluginThemesBridge")
  })

  it("re-exports theme contribution, API, bridge, and registry types", () => {
    const assertTypes = <
      _T extends
        | PluginThemeContribution
        | PluginThemeAPI
        | ThemeColors
        | CustomTheme
        | ThemesBridgeRegisterResult
        | PluginTheme,
    >(): void => undefined

    expect(assertTypes).toBeDefined()
  })
})
