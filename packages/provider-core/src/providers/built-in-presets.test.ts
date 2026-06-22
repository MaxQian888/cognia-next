import {
  BUDGET_PRESET,
  BUILT_IN_PRESETS,
  adaptPresetToEnabledProviders,
  getBuiltInPreset,
} from "./built-in-presets"

describe("provider-core built-in routing presets", () => {
  it("exposes the three canonical built-in presets", () => {
    expect(BUILT_IN_PRESETS.map((preset) => preset.builtInId)).toEqual([
      "budget",
      "performance",
      "reliability",
    ])
    expect(getBuiltInPreset("budget")).toBe(BUDGET_PRESET)
    expect(getBuiltInPreset("performance")?.routingConfig?.strategy).toBe("quality")
  })

  it("filters disabled providers while preserving mapping and fallback order", () => {
    const adapted = adaptPresetToEnabledProviders(BUDGET_PRESET, new Set(["groq", "deepseek"]))

    expect(adapted).not.toBe(BUDGET_PRESET)
    expect(adapted.mappings.length).toBeGreaterThan(0)
    expect(adapted.mappings.flatMap((mapping) => mapping.providers)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ providerId: "groq" }),
        expect.objectContaining({ providerId: "deepseek" }),
      ])
    )
    expect(
      adapted.mappings
        .flatMap((mapping) => mapping.providers)
        .some((entry) => entry.providerId === "openai")
    ).toBe(false)
  })
})
