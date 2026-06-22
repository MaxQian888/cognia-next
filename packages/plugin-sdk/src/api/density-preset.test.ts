import * as sdk from "./density-preset"
import type {
  DensityLevel,
  DensitySettings,
  PluginDensityPresetContribution,
  RegisteredDensityPreset,
} from "./density-preset"

describe("plugin-sdk api/density-preset", () => {
  it("exposes the authoring helper, density registry, and density applier helpers", () => {
    expect(typeof sdk.defineDensityPreset).toBe("function")
    expect(typeof sdk.registerDensityPreset).toBe("function")
    expect(typeof sdk.registerDensityPresetsForPlugin).toBe("function")
    expect(typeof sdk.unregisterDensityPresetsByPlugin).toBe("function")
    expect(typeof sdk.getDensityPreset).toBe("function")
    expect(typeof sdk.listDensityPresets).toBe("function")
    expect(typeof sdk.subscribeDensityPresets).toBe("function")
    expect(typeof sdk.applyDensityPresetVars).toBe("function")
    expect(typeof sdk.clearDensityPresetVars).toBe("function")
    expect(typeof sdk.resolveDensityAttrs).toBe("function")
    expect(typeof sdk.densitySurfaceProps).toBe("function")
  })

  it("re-exports density contribution, registry, and appearance settings types", () => {
    const assertTypes = <
      _T extends
        | PluginDensityPresetContribution
        | RegisteredDensityPreset
        | DensitySettings
        | DensityLevel,
    >(): void => undefined

    expect(assertTypes).toBeDefined()
  })
})
