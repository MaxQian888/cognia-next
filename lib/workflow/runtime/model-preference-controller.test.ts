import { createModelPreferenceController } from "./model-preference-controller"

describe("ModelPreferenceController", () => {
  it("starts in default mode with no hint", () => {
    const c = createModelPreferenceController()
    expect(c.get()).toEqual({ preferCheap: false })
  })

  it("downshift sets preferCheap=true", () => {
    const c = createModelPreferenceController()
    c.downshift()
    expect(c.get()).toMatchObject({ preferCheap: true })
  })

  it("downshift applies cheapModel hint when configured", () => {
    const c = createModelPreferenceController({ cheapModel: "claude-haiku-4-5" })
    c.downshift()
    expect(c.get()).toEqual({ preferCheap: true, modelHint: "claude-haiku-4-5" })
  })

  it("downshift is idempotent", () => {
    const c = createModelPreferenceController({ cheapModel: "haiku" })
    c.downshift()
    c.downshift()
    expect(c.get()).toEqual({ preferCheap: true, modelHint: "haiku" })
  })

  it("subscribe fires once on first downshift", () => {
    const c = createModelPreferenceController()
    const fn = jest.fn()
    c.subscribe(fn)
    c.downshift()
    c.downshift()
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it("unsubscribe stops notifications", () => {
    const c = createModelPreferenceController()
    const fn = jest.fn()
    const unsub = c.subscribe(fn)
    unsub()
    c.downshift()
    expect(fn).not.toHaveBeenCalled()
  })

  it("isolates listener errors", () => {
    const c = createModelPreferenceController()
    const bad = jest.fn(() => {
      throw new Error("boom")
    })
    const good = jest.fn()
    c.subscribe(bad)
    c.subscribe(good)
    c.downshift()
    expect(good).toHaveBeenCalled()
  })
})

describe("lazy cheap-lane resolution", () => {
  it("asks the resolver at downshift time, not at construction", () => {
    // The regression: both production call sites constructed the controller
    // with no options, so `cheapModel` was always undefined and downshift()
    // set a flag nobody read. The budget guard's documented cost escalation
    // therefore never changed a model.
    const resolveCheapModel = jest.fn(() => "fast")
    const ctrl = createModelPreferenceController({ resolveCheapModel })
    expect(resolveCheapModel).not.toHaveBeenCalled()

    ctrl.downshift()
    expect(resolveCheapModel).toHaveBeenCalledTimes(1)
    expect(ctrl.get()).toEqual({ preferCheap: true, modelHint: "fast" })
  })

  it("keeps the preferCheap-only state when there is no cheap lane", () => {
    const ctrl = createModelPreferenceController({ resolveCheapModel: () => undefined })
    ctrl.downshift()
    expect(ctrl.get()).toEqual({ preferCheap: true })
  })

  it("never lets a throwing resolver take the run with it", () => {
    const ctrl = createModelPreferenceController({
      resolveCheapModel: () => {
        throw new Error("settings unavailable")
      },
    })
    expect(() => ctrl.downshift()).not.toThrow()
    expect(ctrl.get()).toEqual({ preferCheap: true })
  })

  it("still honours an explicit cheapModel without calling the resolver", () => {
    const resolveCheapModel = jest.fn(() => "fast")
    const ctrl = createModelPreferenceController({ cheapModel: "pinned", resolveCheapModel })
    ctrl.downshift()
    expect(ctrl.get().modelHint).toBe("pinned")
    expect(resolveCheapModel).not.toHaveBeenCalled()
  })
})
