import { DEFAULT_ROUTING_PRESETS_STATE, type CustomPreset } from "./routing-presets"

describe("DEFAULT_ROUTING_PRESETS_STATE", () => {
  it("starts without an active preset or revert snapshot", () => {
    expect(DEFAULT_ROUTING_PRESETS_STATE).toEqual({
      customPresets: [],
      activePresetId: null,
      preActivationSnapshot: null,
    })
  })
})

describe("CustomPreset contract", () => {
  it("requires a creation timestamp and custom marker", () => {
    const preset: CustomPreset = {
      id: "custom",
      name: "Custom",
      description: "Custom preset",
      isBuiltIn: false,
      strategy: "balanced",
      mappings: [],
      createdAt: 1,
    }

    expect(preset.isBuiltIn).toBe(false)
    expect(preset.createdAt).toBe(1)
  })
})
