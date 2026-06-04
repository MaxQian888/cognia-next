import { renderHook } from "@testing-library/react"
import { useLive2dMotion, type Live2dModelLike } from "./use-live2d-motion"
import type { Live2dCapabilities } from "@/lib/pet/live2d/types"
import type { PetOneShot, PetVisualState } from "@/types/pet"

function makeModel() {
  const stopAllMotions = jest.fn()
  const model: Live2dModelLike = {
    motion: jest.fn(),
    expression: jest.fn(),
    internalModel: { motionManager: { stopAllMotions } },
  }
  return { model, stopAllMotions }
}

// Hiyori-like capabilities: Idle/Tap/TapBody motions + a happy expression.
const caps: Live2dCapabilities = {
  motionGroups: ["Idle", "Tap", "TapBody"],
  expressionIds: ["happy"],
}

interface Args {
  model: Live2dModelLike | null
  state: PetVisualState
  oneShot: PetOneShot | null
  caps: Live2dCapabilities
  reducedMotion: boolean
}

function setup(initial: Args) {
  return renderHook(
    (p: Args) => useLive2dMotion(p.model, p.state, p.oneShot, p.caps, p.reducedMotion),
    {
      initialProps: initial,
    }
  )
}

describe("useLive2dMotion", () => {
  it("applies an idle-priority motion for the resting idle state", () => {
    const { model } = makeModel()
    setup({ model, state: "idle", oneShot: null, caps, reducedMotion: false })
    // Idle resolves to the "Idle" group at idle priority (1).
    expect(model.motion).toHaveBeenCalledWith("Idle", 0, 1)
  })

  it("applies a normal-priority motion on state change", () => {
    const { model } = makeModel()
    const view = setup({ model, state: "idle", oneShot: null, caps, reducedMotion: false })
    ;(model.motion as jest.Mock).mockClear()
    view.rerender({ model, state: "greeting", oneShot: null, caps, reducedMotion: false })
    // greeting → Tap at normal priority (2).
    expect(model.motion).toHaveBeenCalledWith("Tap", 0, 2)
  })

  it("does not re-apply the resting motion when state is unchanged", () => {
    const { model } = makeModel()
    const view = setup({ model, state: "idle", oneShot: null, caps, reducedMotion: false })
    ;(model.motion as jest.Mock).mockClear()
    view.rerender({ model, state: "idle", oneShot: null, caps, reducedMotion: false })
    expect(model.motion).not.toHaveBeenCalled()
  })

  it("edge-triggers a one-shot at force priority exactly once", () => {
    const { model } = makeModel()
    const view = setup({ model, state: "idle", oneShot: null, caps, reducedMotion: false })
    ;(model.motion as jest.Mock).mockClear()
    view.rerender({ model, state: "idle", oneShot: "fed", caps, reducedMotion: false })
    expect(model.motion).toHaveBeenCalledWith("TapBody", 0, 3)
    ;(model.motion as jest.Mock).mockClear()
    // Same shot still active on the next render → must NOT replay.
    view.rerender({ model, state: "idle", oneShot: "fed", caps, reducedMotion: false })
    expect(model.motion).not.toHaveBeenCalled()
  })

  it("applies a matching expression for happy and falls back when none matches", () => {
    const { model } = makeModel()
    setup({ model, state: "happy", oneShot: null, caps, reducedMotion: false })
    expect(model.expression).toHaveBeenCalledWith("happy")
  })

  it("does not call expression when the state maps to no available expression", () => {
    const { model } = makeModel()
    // sad maps to ["sad","f03"] expressions; caps only has "happy" → no match.
    setup({ model, state: "sad", oneShot: null, caps, reducedMotion: false })
    expect(model.expression).not.toHaveBeenCalled()
  })

  it("falls back to native motion (no motion call) when no group matches", () => {
    const { model } = makeModel()
    // Capabilities with no usable groups for idle.
    setup({
      model,
      state: "idle",
      oneShot: null,
      caps: { motionGroups: ["NopeGroup"], expressionIds: [] },
      reducedMotion: false,
    })
    expect(model.motion).not.toHaveBeenCalled()
  })

  it("stops all motions once on entering reduced motion and applies nothing", () => {
    const { model, stopAllMotions } = makeModel()
    const view = setup({ model, state: "idle", oneShot: null, caps, reducedMotion: false })
    ;(model.motion as jest.Mock).mockClear()
    view.rerender({ model, state: "idle", oneShot: null, caps, reducedMotion: true })
    expect(stopAllMotions).toHaveBeenCalledTimes(1)
    expect(model.motion).not.toHaveBeenCalled()
    // Staying reduced does not call stopAllMotions again.
    view.rerender({ model, state: "happy", oneShot: null, caps, reducedMotion: true })
    expect(stopAllMotions).toHaveBeenCalledTimes(1)
  })

  it("re-applies a plan after leaving reduced motion", () => {
    const { model } = makeModel()
    const view = setup({ model, state: "idle", oneShot: null, caps, reducedMotion: true })
    ;(model.motion as jest.Mock).mockClear()
    view.rerender({ model, state: "idle", oneShot: null, caps, reducedMotion: false })
    expect(model.motion).toHaveBeenCalledWith("Idle", 0, 1)
  })

  it("is a no-op while the model is null", () => {
    const { model } = makeModel()
    const view = setup({ model: null, state: "idle", oneShot: null, caps, reducedMotion: false })
    // Now provide a model — the first real model should get a fresh plan.
    view.rerender({ model, state: "idle", oneShot: null, caps, reducedMotion: false })
    expect(model.motion).toHaveBeenCalledWith("Idle", 0, 1)
  })

  it("tolerates a model without an internalModel motion manager under reduced motion", () => {
    const model: Live2dModelLike = { motion: jest.fn(), expression: jest.fn() }
    const view = setup({ model, state: "idle", oneShot: null, caps, reducedMotion: false })
    expect(() =>
      view.rerender({ model, state: "idle", oneShot: null, caps, reducedMotion: true })
    ).not.toThrow()
  })
})
