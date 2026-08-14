import {
  __resetPythonRuntimeGenerationsForTesting,
  bindPythonRuntimeGeneration,
  capturePythonRuntimeGeneration,
  unbindPythonRuntimeGeneration,
} from "./runtime-generation"

describe("python runtime generation registry", () => {
  beforeEach(() => {
    __resetPythonRuntimeGenerationsForTesting()
  })

  it("captures the generation bound by the active manager", () => {
    bindPythonRuntimeGeneration("plugin-a", "generation-1")

    expect(capturePythonRuntimeGeneration("plugin-a")).toBe("generation-1")
  })

  it("does not let stale teardown remove a replacement generation", () => {
    bindPythonRuntimeGeneration("plugin-a", "generation-1")
    bindPythonRuntimeGeneration("plugin-a", "generation-2")

    unbindPythonRuntimeGeneration("plugin-a", "generation-1")

    expect(capturePythonRuntimeGeneration("plugin-a")).toBe("generation-2")
  })

  it("rejects proxy creation when no runtime generation is bound", () => {
    expect(() => capturePythonRuntimeGeneration("plugin-a")).toThrow(
      "Python runtime generation is unavailable for plugin-a"
    )
  })
})
