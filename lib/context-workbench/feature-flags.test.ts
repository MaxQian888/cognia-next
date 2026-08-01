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
      JSON.stringify({ canvas: false, project: true, workflow: true })
    )
    const { getContextWorkbenchSurfaceFlags } = await import("./feature-flags")
    expect(getContextWorkbenchSurfaceFlags()).toEqual({
      canvas: false,
      project: true,
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
      workflow: false,
    })
  })

  it("ignores malformed persisted values", async () => {
    window.localStorage.setItem("cognia-context-workbench-surfaces-v1", "not-json")
    const { isContextWorkbenchSurfaceEnabled } = await import("./feature-flags")
    expect(isContextWorkbenchSurfaceEnabled("project")).toBe(true)
  })

  it.each(["1", "true"])("accepts the enabled environment value %s", async (value) => {
    process.env.NEXT_PUBLIC_CONTEXT_WORKBENCH_V1 = value
    const { getContextWorkbenchSurfaceFlags } = await import("./feature-flags")
    expect(getContextWorkbenchSurfaceFlags()).toEqual({
      canvas: true,
      project: true,
      workflow: true,
    })
  })
})

describe("dock kernel surface flags", () => {
  const originalEnvironment = process.env.NEXT_PUBLIC_DOCK_KERNEL

  beforeEach(() => {
    window.localStorage.clear()
    delete process.env.NEXT_PUBLIC_DOCK_KERNEL
  })

  afterAll(() => {
    process.env.NEXT_PUBLIC_DOCK_KERNEL = originalEnvironment
  })

  it("ships chat on the Dock and every other host still on the workbench", async () => {
    const { getDockKernelSurfaceFlags } = await import("./feature-flags")
    expect(getDockKernelSurfaceFlags()).toEqual({
      chat: true,
      canvas: false,
      project: false,
      workflow: false,
    })
  })

  it("lets a user opt one host in or out without touching the rest", async () => {
    window.localStorage.setItem(
      "cognia-dock-kernel-surfaces-v1",
      JSON.stringify({ chat: false, project: true })
    )
    const { getDockKernelSurfaceFlags, isDockKernelSurfaceEnabled } =
      await import("./feature-flags")
    expect(getDockKernelSurfaceFlags()).toEqual({
      chat: false,
      canvas: false,
      project: true,
      workflow: false,
    })
    expect(isDockKernelSurfaceEnabled("chat")).toBe(false)
  })

  it.each(["0", "false"])(
    "lets the build-level kill switch %s override a user opt-in",
    async (value) => {
      // The reason to ship a build with the switch off is that the Dock is the
      // suspect; a stale localStorage key must not talk it back on.
      process.env.NEXT_PUBLIC_DOCK_KERNEL = value
      window.localStorage.setItem(
        "cognia-dock-kernel-surfaces-v1",
        JSON.stringify({ chat: true, canvas: true, project: true, workflow: true })
      )
      const { getDockKernelSurfaceFlags } = await import("./feature-flags")
      expect(getDockKernelSurfaceFlags()).toEqual({
        chat: false,
        canvas: false,
        project: false,
        workflow: false,
      })
    }
  )

  it.each(["1", "true"])("turns every host on with the environment value %s", async (value) => {
    process.env.NEXT_PUBLIC_DOCK_KERNEL = value
    const { getDockKernelSurfaceFlags } = await import("./feature-flags")
    expect(getDockKernelSurfaceFlags()).toEqual({
      chat: true,
      canvas: true,
      project: true,
      workflow: true,
    })
  })

  it("still honours a per-host opt-out under a global opt-in", async () => {
    // Unlike the kill switch, turning the Dock on is only a default — a user
    // who hit a bug on one host can still step that host back.
    process.env.NEXT_PUBLIC_DOCK_KERNEL = "1"
    window.localStorage.setItem("cognia-dock-kernel-surfaces-v1", JSON.stringify({ canvas: false }))
    const { getDockKernelSurfaceFlags } = await import("./feature-flags")
    expect(getDockKernelSurfaceFlags()).toMatchObject({ chat: true, canvas: false })
  })

  it("ignores a malformed persisted value rather than failing closed", async () => {
    window.localStorage.setItem("cognia-dock-kernel-surfaces-v1", "not-json")
    const { isDockKernelSurfaceEnabled } = await import("./feature-flags")
    expect(isDockKernelSurfaceEnabled("chat")).toBe(true)
  })
})
