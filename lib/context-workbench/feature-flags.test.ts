/** @jest-environment jsdom */

describe("context workbench surface flags", () => {
  const originalEnvironment = process.env.NEXT_PUBLIC_CONTEXT_WORKBENCH_V1

  beforeEach(() => {
    window.localStorage.clear()
    delete process.env.NEXT_PUBLIC_CONTEXT_WORKBENCH_V1
  })

  afterAll(() => {
    process.env.NEXT_PUBLIC_CONTEXT_WORKBENCH_V1 = originalEnvironment
  })

  it("allows each surface to be enabled independently", async () => {
    window.localStorage.setItem(
      "cognia-context-workbench-surfaces-v1",
      JSON.stringify({ canvas: false, project: true, artifact: false, workflow: true })
    )
    const { getContextWorkbenchSurfaceFlags } = await import("./feature-flags")
    expect(getContextWorkbenchSurfaceFlags()).toEqual({
      canvas: false,
      project: true,
      artifact: false,
      workflow: true,
    })
  })

  it("uses the global environment default and preserves the legacy Canvas override", async () => {
    process.env.NEXT_PUBLIC_CONTEXT_WORKBENCH_V1 = "false"
    window.localStorage.setItem(
      "cognia-canvas-feature-flags-v1",
      JSON.stringify({ "contextWorkbench.v1": true })
    )
    const { getContextWorkbenchSurfaceFlags } = await import("./feature-flags")
    expect(getContextWorkbenchSurfaceFlags()).toEqual({
      canvas: true,
      project: false,
      artifact: false,
      workflow: false,
    })
  })

  it("ignores malformed persisted values", async () => {
    window.localStorage.setItem("cognia-context-workbench-surfaces-v1", "not-json")
    const { isContextWorkbenchSurfaceEnabled } = await import("./feature-flags")
    expect(isContextWorkbenchSurfaceEnabled("artifact")).toBe(true)
  })

  it.each(["1", "true"])("accepts the enabled environment value %s", async (value) => {
    process.env.NEXT_PUBLIC_CONTEXT_WORKBENCH_V1 = value
    const { getContextWorkbenchSurfaceFlags } = await import("./feature-flags")
    expect(getContextWorkbenchSurfaceFlags()).toEqual({
      canvas: true,
      project: true,
      artifact: true,
      workflow: true,
    })
  })
})
