import * as sdk from "./density-preset"
import type {
  DensityLevel,
  DensitySettings,
  PluginDensityPresetContribution,
  RegisteredDensityPreset,
} from "./density-preset"

describe("plugin-sdk api/density-preset", () => {
  it("exposes the authoring helper and the density registry", () => {
    expect(typeof sdk.defineDensityPreset).toBe("function")
    expect(typeof sdk.registerDensityPreset).toBe("function")
    expect(typeof sdk.registerDensityPresetsForPlugin).toBe("function")
    expect(typeof sdk.unregisterDensityPresetsByPlugin).toBe("function")
    expect(typeof sdk.getDensityPreset).toBe("function")
    expect(typeof sdk.listDensityPresets).toBe("function")
    expect(typeof sdk.subscribeDensityPresets).toBe("function")
  })

  it("keeps host wiring off the author surface (the host applies density itself)", () => {
    expect(sdk).not.toHaveProperty("applyDensityPresetVars")
    expect(sdk).not.toHaveProperty("clearDensityPresetVars")
    expect(sdk).not.toHaveProperty("resolveDensityAttrs")
    expect(sdk).not.toHaveProperty("densitySurfaceProps")
  })

  it("re-exports density contribution, registry, and appearance settings types", () => {
    const assertTypes = <
      _T extends
        PluginDensityPresetContribution | RegisteredDensityPreset | DensitySettings | DensityLevel,
    >(): void => undefined

    expect(assertTypes).toBeDefined()
  })
})
