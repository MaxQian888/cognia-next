import {
  BUDGET_PRESET,
  BUILT_IN_PRESETS,
  adaptPresetToEnabledProviders,
  getBuiltInPreset,
} from "./built-in-presets"

describe("provider-routing built-in presets", () => {
  it("exposes budget, performance, and reliability presets", () => {
    expect(BUILT_IN_PRESETS).toHaveLength(3)
    expect(getBuiltInPreset("budget")).toBe(BUDGET_PRESET)
    expect(getBuiltInPreset("reliability")?.routingConfig?.maxFallbackAttempts).toBe(5)
  })

  it("drops mappings that have no enabled providers after adaptation", () => {
    const adapted = adaptPresetToEnabledProviders(BUDGET_PRESET, new Set(["groq"]))

    expect(adapted.mappings.length).toBeLessThanOrEqual(BUDGET_PRESET.mappings.length)
    expect(adapted.mappings.every((mapping) => mapping.providers.length > 0)).toBe(true)
    expect(
      adapted.mappings
        .flatMap((mapping) => mapping.providers)
        .every((entry) => entry.providerId === "groq")
    ).toBe(true)
  })
})
