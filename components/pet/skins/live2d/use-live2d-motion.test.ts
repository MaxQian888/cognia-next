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
  walking?: boolean
  overrides?: import("@/types/pet").Live2dMotionOverrides
}

function setup(initial: Args) {
  return renderHook(
    (p: Args) =>
      useLive2dMotion(p.model, p.state, p.oneShot, p.caps, p.reducedMotion, p.walking, p.overrides),
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

  describe("walking (overlay wandering)", () => {
    const walkCaps: Live2dCapabilities = {
      motionGroups: ["Idle", "Walk", "Tap"],
      expressionIds: [],
    }

    it("plays the model's walk group at idle priority on the walking edge", () => {
      const { model } = makeModel()
      const view = setup({
        model,
        state: "idle",
        oneShot: null,
        caps: walkCaps,
        reducedMotion: false,
      })
      ;(model.motion as jest.Mock).mockClear()
      view.rerender({
        model,
        state: "idle",
        oneShot: null,
        caps: walkCaps,
        reducedMotion: false,
        walking: true,
      })
      expect(model.motion).toHaveBeenCalledWith("Walk", 0, 1)
    })

    it("falls back to Idle when the model has no walk-ish group", () => {
      const { model } = makeModel()
      const view = setup({ model, state: "happy", oneShot: null, caps, reducedMotion: false })
      ;(model.motion as jest.Mock).mockClear()
      view.rerender({
        model,
        state: "happy",
        oneShot: null,
        caps,
        reducedMotion: false,
        walking: true,
      })
      expect(model.motion).toHaveBeenCalledWith("Idle", 0, 1)
    })

    it("does not replay the walk plan on re-renders while walking persists", () => {
      const { model } = makeModel()
      const view = setup({
        model,
        state: "idle",
        oneShot: null,
        caps: walkCaps,
        reducedMotion: false,
        walking: true,
      })
      ;(model.motion as jest.Mock).mockClear()
      view.rerender({
        model,
        state: "idle",
        oneShot: null,
        caps: walkCaps,
        reducedMotion: false,
        walking: true,
      })
      expect(model.motion).not.toHaveBeenCalled()
    })

    it("re-applies the resting plan when walking stops", () => {
      const { model } = makeModel()
      const view = setup({
        model,
        state: "idle",
        oneShot: null,
        caps: walkCaps,
        reducedMotion: false,
        walking: true,
      })
      ;(model.motion as jest.Mock).mockClear()
      view.rerender({
        model,
        state: "idle",
        oneShot: null,
        caps: walkCaps,
        reducedMotion: false,
        walking: false,
      })
      expect(model.motion).toHaveBeenCalledWith("Idle", 0, 1)
    })

    it("one-shots preempt the walk plan at force priority", () => {
      const { model } = makeModel()
      const view = setup({
        model,
        state: "idle",
        oneShot: null,
        caps: walkCaps,
        reducedMotion: false,
        walking: true,
      })
      ;(model.motion as jest.Mock).mockClear()
      view.rerender({
        model,
        state: "idle",
        oneShot: "wave",
        caps: walkCaps,
        reducedMotion: false,
        walking: true,
      })
      expect(model.motion).toHaveBeenCalledWith("Tap", 0, 3)
    })

    it("reduced motion suppresses the walk plan", () => {
      const { model } = makeModel()
      const view = setup({
        model,
        state: "idle",
        oneShot: null,
        caps: walkCaps,
        reducedMotion: true,
      })
      ;(model.motion as jest.Mock).mockClear()
      view.rerender({
        model,
        state: "idle",
        oneShot: null,
        caps: walkCaps,
        reducedMotion: true,
        walking: true,
      })
      expect(model.motion).not.toHaveBeenCalled()
    })
  })

  describe("per-model overrides", () => {
    const countedCaps: Live2dCapabilities = {
      motionGroups: ["Idle", "Tap", "Special"],
      expressionIds: ["happy"],
      motionGroupCounts: { Special: 4, Tap: 1 },
    }

    it("threads overrides into the resting plan", () => {
      const { model } = makeModel()
      setup({
        model,
        state: "idle",
        oneShot: null,
        caps: countedCaps,
        reducedMotion: false,
        overrides: { idle: { motionGroup: "Tap", motionIndex: 0 } },
      })
      expect(model.motion).toHaveBeenCalledWith("Tap", 0, 1)
    })

    it("threads overrides into the one-shot plan (namespaced key)", () => {
      const { model } = makeModel()
      const overrides = { "shot:wave": { motionGroup: "Special", motionIndex: 1 } }
      const view = setup({
        model,
        state: "idle",
        oneShot: null,
        caps: countedCaps,
        reducedMotion: false,
        overrides,
      })
      ;(model.motion as jest.Mock).mockClear()
      view.rerender({
        model,
        state: "idle",
        oneShot: "wave",
        caps: countedCaps,
        reducedMotion: false,
        overrides,
      })
      expect(model.motion).toHaveBeenCalledWith("Special", 1, 3)
    })

    it("draws a random in-range index when the override leaves it unset", () => {
      const { model } = makeModel()
      const rng = jest.spyOn(Math, "random").mockReturnValue(0.6)
      try {
        setup({
          model,
          state: "idle",
          oneShot: null,
          caps: countedCaps,
          reducedMotion: false,
          overrides: { idle: { motionGroup: "Special" } },
        })
        // 0.6 * 4 → index 2.
        expect(model.motion).toHaveBeenCalledWith("Special", 2, 1)
      } finally {
        rng.mockRestore()
      }
    })

    it("falls back to index 0 when the group count is unknown or 1", () => {
      const { model } = makeModel()
      setup({
        model,
        state: "idle",
        oneShot: null,
        caps: countedCaps,
        reducedMotion: false,
        overrides: { idle: { motionGroup: "Idle" } }, // count unknown
      })
      expect(model.motion).toHaveBeenCalledWith("Idle", 0, 1)
    })

    it("an engine-default override applies no motion (native breathing)", () => {
      const { model } = makeModel()
      setup({
        model,
        state: "idle",
        oneShot: null,
        caps: countedCaps,
        reducedMotion: false,
        overrides: { idle: {} },
      })
      expect(model.motion).not.toHaveBeenCalled()
    })
  })
})
