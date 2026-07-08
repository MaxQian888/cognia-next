/** @jest-environment jsdom */
describe("canvas feature flags", () => {
  const originalCollab = process.env.NEXT_PUBLIC_CANVAS_COLLABORATION_V1
  const originalAi = process.env.NEXT_PUBLIC_CANVAS_AI_WORKBENCH_V1

  beforeEach(() => {
    localStorage.clear()
    delete process.env.NEXT_PUBLIC_CANVAS_COLLABORATION_V1
    delete process.env.NEXT_PUBLIC_CANVAS_AI_WORKBENCH_V1
    jest.resetModules()
  })

  afterAll(() => {
    if (originalCollab === undefined) {
      delete process.env.NEXT_PUBLIC_CANVAS_COLLABORATION_V1
    } else {
      process.env.NEXT_PUBLIC_CANVAS_COLLABORATION_V1 = originalCollab
    }
    if (originalAi === undefined) {
      delete process.env.NEXT_PUBLIC_CANVAS_AI_WORKBENCH_V1
    } else {
      process.env.NEXT_PUBLIC_CANVAS_AI_WORKBENCH_V1 = originalAi
    }
  })

  it("reads canvas.collaboration.v1 from localStorage", async () => {
    localStorage.setItem(
      "cognia-canvas-feature-flags-v1",
      JSON.stringify({
        "canvas.collaboration.v1": false,
      })
    )

    const { getCanvasFeatureFlags } = await import("./feature-flags")
    expect(getCanvasFeatureFlags()["canvas.collaboration.v1"]).toBe(false)
  })

  it("reads canvas.collaboration.v1 from environment overrides", async () => {
    process.env.NEXT_PUBLIC_CANVAS_COLLABORATION_V1 = "false"

    const { getCanvasFeatureFlags } = await import("./feature-flags")
    expect(getCanvasFeatureFlags()["canvas.collaboration.v1"]).toBe(false)
  })

  it("reads canvas.aiWorkbench.v1 from localStorage", async () => {
    localStorage.setItem(
      "cognia-canvas-feature-flags-v1",
      JSON.stringify({
        "canvas.aiWorkbench.v1": false,
      })
    )

    const { getCanvasFeatureFlags } = await import("./feature-flags")
    expect(getCanvasFeatureFlags()["canvas.aiWorkbench.v1"]).toBe(false)
  })

  it("returns default flags when no localStorage value", async () => {
    const { getCanvasFeatureFlags } = await import("./feature-flags")
    const flags = getCanvasFeatureFlags()
    expect(flags["canvas.aiWorkbench.v1"]).toBe(true)
    expect(flags["canvas.collaboration.v1"]).toBe(true)
  })

  it("ignores malformed localStorage JSON", async () => {
    localStorage.setItem("cognia-canvas-feature-flags-v1", "{not-json")

    const { getCanvasFeatureFlags } = await import("./feature-flags")
    const flags = getCanvasFeatureFlags()
    expect(flags["canvas.aiWorkbench.v1"]).toBe(true)
    expect(flags["canvas.collaboration.v1"]).toBe(true)
  })

  it("ignores non-boolean values stored in localStorage", async () => {
    localStorage.setItem(
      "cognia-canvas-feature-flags-v1",
      JSON.stringify({
        "canvas.aiWorkbench.v1": "maybe",
        "canvas.collaboration.v1": 1,
      })
    )

    const { getCanvasFeatureFlags } = await import("./feature-flags")
    const flags = getCanvasFeatureFlags()
    expect(flags["canvas.aiWorkbench.v1"]).toBe(true)
    expect(flags["canvas.collaboration.v1"]).toBe(true)
  })

  it('handles env "0" value as false', async () => {
    process.env.NEXT_PUBLIC_CANVAS_AI_WORKBENCH_V1 = "0"
    process.env.NEXT_PUBLIC_CANVAS_COLLABORATION_V1 = "0"

    const { getCanvasFeatureFlags } = await import("./feature-flags")
    const flags = getCanvasFeatureFlags()
    expect(flags["canvas.aiWorkbench.v1"]).toBe(false)
    expect(flags["canvas.collaboration.v1"]).toBe(false)
  })

  it('handles env "1" value as true', async () => {
    process.env.NEXT_PUBLIC_CANVAS_AI_WORKBENCH_V1 = "1"
    process.env.NEXT_PUBLIC_CANVAS_COLLABORATION_V1 = "1"

    const { getCanvasFeatureFlags } = await import("./feature-flags")
    const flags = getCanvasFeatureFlags()
    expect(flags["canvas.aiWorkbench.v1"]).toBe(true)
    expect(flags["canvas.collaboration.v1"]).toBe(true)
  })

  it('handles env "true" value as true', async () => {
    process.env.NEXT_PUBLIC_CANVAS_AI_WORKBENCH_V1 = "true"
    process.env.NEXT_PUBLIC_CANVAS_COLLABORATION_V1 = "true"

    const { getCanvasFeatureFlags } = await import("./feature-flags")
    const flags = getCanvasFeatureFlags()
    expect(flags["canvas.aiWorkbench.v1"]).toBe(true)
    expect(flags["canvas.collaboration.v1"]).toBe(true)
  })

  it("ignores unrecognized env values", async () => {
    process.env.NEXT_PUBLIC_CANVAS_AI_WORKBENCH_V1 = "maybe"
    process.env.NEXT_PUBLIC_CANVAS_COLLABORATION_V1 = "unsure"

    const { getCanvasFeatureFlags } = await import("./feature-flags")
    const flags = getCanvasFeatureFlags()
    // Defaults remain
    expect(flags["canvas.aiWorkbench.v1"]).toBe(true)
    expect(flags["canvas.collaboration.v1"]).toBe(true)
  })

  it("localStorage takes precedence over env", async () => {
    process.env.NEXT_PUBLIC_CANVAS_AI_WORKBENCH_V1 = "false"
    localStorage.setItem(
      "cognia-canvas-feature-flags-v1",
      JSON.stringify({
        "canvas.aiWorkbench.v1": true,
      })
    )

    const { getCanvasFeatureFlags } = await import("./feature-flags")
    expect(getCanvasFeatureFlags()["canvas.aiWorkbench.v1"]).toBe(true)
  })

  it("isCanvasFeatureFlagEnabled returns boolean for known flag", async () => {
    const { isCanvasFeatureFlagEnabled } = await import("./feature-flags")
    expect(isCanvasFeatureFlagEnabled("canvas.aiWorkbench.v1")).toBe(true)
    expect(isCanvasFeatureFlagEnabled("canvas.collaboration.v1")).toBe(true)
  })
})
