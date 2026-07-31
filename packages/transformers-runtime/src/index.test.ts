import * as runtime from "./index"

describe("public API", () => {
  it("exports runtime operations, capability detection, and model presets", () => {
    expect(runtime.TransformersManager).toBeDefined()
    expect(runtime.getTransformersCapabilities).toBeInstanceOf(Function)
    expect(runtime.TRANSFORMERS_MODEL_PRESETS.length).toBeGreaterThan(0)
  })
})
