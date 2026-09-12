import {
  __resetArtifactPickersForTests,
  armArtifactPicker,
  canPickArtifactElements,
  disarmArtifactPicker,
  registerArtifactPicker,
  type ArtifactPickController,
} from "./element-pick-registry"

function controller(): ArtifactPickController & { arm: jest.Mock; disarm: jest.Mock } {
  return { arm: jest.fn(), disarm: jest.fn() }
}

beforeEach(() => {
  __resetArtifactPickersForTests()
})

describe("element pick registry", () => {
  it("reports no picker until a preview registers one", () => {
    expect(canPickArtifactElements("a1")).toBe(false)
    registerArtifactPicker("a1", controller())
    expect(canPickArtifactElements("a1")).toBe(true)
  })

  it("treats a missing id as unpickable rather than throwing", () => {
    expect(canPickArtifactElements(null)).toBe(false)
    expect(canPickArtifactElements(undefined)).toBe(false)
  })

  it("arms the registered controller with the caller's handlers", () => {
    const ctl = controller()
    registerArtifactPicker("a1", ctl)
    const request = { onPick: jest.fn(), originLabel: "artifact preview" }

    expect(armArtifactPicker("a1", request)).toBe(true)
    expect(ctl.arm).toHaveBeenCalledWith(request)
  })

  it("reports false when no preview is mounted, so a toggle cannot stick on", () => {
    expect(armArtifactPicker("missing", { onPick: jest.fn() })).toBe(false)
  })

  it("disarming an artifact with no preview is a no-op, not a throw", () => {
    // The ordinary teardown order: the dock closes, the preview unmounts, and
    // the toolbar's cleanup still runs.
    expect(() => disarmArtifactPicker("missing")).not.toThrow()
  })

  it("a remount replaces the registration instead of stacking one", () => {
    const first = controller()
    const second = controller()
    registerArtifactPicker("a1", first)
    registerArtifactPicker("a1", second)

    armArtifactPicker("a1", { onPick: jest.fn() })
    expect(first.arm).not.toHaveBeenCalled()
    expect(second.arm).toHaveBeenCalledTimes(1)
  })

  it("a stale disposer cannot unregister the live preview that replaced it", () => {
    const first = controller()
    const second = controller()
    const disposeFirst = registerArtifactPicker("a1", first)
    registerArtifactPicker("a1", second)

    // React 19 runs the OLD ref cleanup after the new one registers.
    disposeFirst()

    expect(canPickArtifactElements("a1")).toBe(true)
    armArtifactPicker("a1", { onPick: jest.fn() })
    expect(second.arm).toHaveBeenCalledTimes(1)
  })

  it("keeps artifacts independent", () => {
    const a = controller()
    const b = controller()
    registerArtifactPicker("a1", a)
    registerArtifactPicker("a2", b)

    armArtifactPicker("a1", { onPick: jest.fn() })
    disarmArtifactPicker("a2")

    expect(a.arm).toHaveBeenCalledTimes(1)
    expect(a.disarm).not.toHaveBeenCalled()
    expect(b.arm).not.toHaveBeenCalled()
    expect(b.disarm).toHaveBeenCalledTimes(1)
  })

  it("drops the registration on dispose", () => {
    const dispose = registerArtifactPicker("a1", controller())
    dispose()
    expect(canPickArtifactElements("a1")).toBe(false)
  })
})
