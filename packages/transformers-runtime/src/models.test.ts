import { TRANSFORMERS_MODEL_PRESETS, getModelPresetsForTask } from "./models"

describe("Transformers model presets", () => {
  it("offers curated presets across text, audio, and vision tasks", () => {
    expect(getModelPresetsForTask("feature-extraction").length).toBeGreaterThan(0)
    expect(getModelPresetsForTask("automatic-speech-recognition").length).toBeGreaterThan(0)
    expect(getModelPresetsForTask("image-classification").length).toBeGreaterThan(0)
    expect(TRANSFORMERS_MODEL_PRESETS.every((preset) => preset.modelId && preset.label)).toBe(true)
  })
})
