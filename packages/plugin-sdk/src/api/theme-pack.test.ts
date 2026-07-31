import * as sdk from "./theme-pack"
import type { PluginThemePackContribution, RegisteredThemePack } from "./theme-pack"

describe("plugin-sdk api/theme-pack", () => {
  it("exposes the authoring helper and theme-pack registry", () => {
    expect(typeof sdk.defineThemePack).toBe("function")
    expect(typeof sdk.registerThemePack).toBe("function")
    expect(typeof sdk.unregisterThemePack).toBe("function")
    expect(typeof sdk.unregisterThemePacksByPlugin).toBe("function")
    expect(typeof sdk.listThemePacks).toBe("function")
    expect(typeof sdk.getThemePack).toBe("function")
    expect(typeof sdk.subscribeThemePackRegistry).toBe("function")
  })

  it("re-exports theme-pack contribution and registry types", () => {
    const assertTypes = <_T extends PluginThemePackContribution | RegisteredThemePack>(): void =>
      undefined

    expect(assertTypes).toBeDefined()
  })
})
