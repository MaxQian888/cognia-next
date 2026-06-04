import type { PetOneShot, PetVisualState } from "@/types/pet"
import { resolveLive2dPlan } from "./state-mapping"
import type { Live2dCapabilities } from "./types"

const ALL_STATES: PetVisualState[] = [
  "idle",
  "thinking",
  "waiting",
  "review",
  "happy",
  "sad",
  "error",
  "sleeping",
  "greeting",
  "evolving",
  "interacting",
]

const ALL_SHOTS: PetOneShot[] = ["wave", "happy", "fed", "petted", "evolving", "levelUp"]

const RICH: Live2dCapabilities = {
  motionGroups: ["Idle", "Tap", "TapBody", "Tap@Body", "Flick", "TapHead", "Special", "Greeting"],
  expressionIds: ["happy", "sad", "angry", "sleepy", "f01", "f02", "f03"],
}

const EMPTY: Live2dCapabilities = { motionGroups: [], expressionIds: [] }

describe("resolveLive2dPlan — resting states", () => {
  it("plays idle at idle priority", () => {
    const plan = resolveLive2dPlan("idle", null, RICH, false)
    expect(plan).toMatchObject({ motionGroup: "Idle", motionIndex: 0, priority: "idle" })
    expect(plan.parameterFallback).toBe(false)
  })

  it.each(["idle", "sleeping", "sad"] as PetVisualState[])("%s uses idle priority", (state) => {
    expect(resolveLive2dPlan(state, null, RICH, false).priority).toBe("idle")
  })

  it.each([
    "thinking",
    "waiting",
    "review",
    "happy",
    "error",
    "greeting",
    "evolving",
    "interacting",
  ] as PetVisualState[])("%s uses normal priority", (state) => {
    expect(resolveLive2dPlan(state, null, RICH, false).priority).toBe("normal")
  })

  it("resolves expressions for happy / sad / error / sleeping", () => {
    expect(resolveLive2dPlan("happy", null, RICH, false).expressionId).toBe("happy")
    expect(resolveLive2dPlan("sad", null, RICH, false).expressionId).toBe("sad")
    expect(resolveLive2dPlan("error", null, RICH, false).expressionId).toBe("angry")
    expect(resolveLive2dPlan("sleeping", null, RICH, false).expressionId).toBe("sleepy")
  })

  it("falls back to f-series expression when named one is missing", () => {
    const caps: Live2dCapabilities = { motionGroups: ["Idle"], expressionIds: ["f03"] }
    expect(resolveLive2dPlan("sad", null, caps, false).expressionId).toBe("f03")
  })

  it("omits expression when none of the candidates match", () => {
    const caps: Live2dCapabilities = { motionGroups: ["Idle"], expressionIds: ["unrelated"] }
    expect(resolveLive2dPlan("happy", null, caps, false).expressionId).toBeUndefined()
  })

  it("routes error to Flick when present", () => {
    expect(resolveLive2dPlan("error", null, RICH, false).motionGroup).toBe("Flick")
  })

  it("routes evolving to Special when present", () => {
    expect(resolveLive2dPlan("evolving", null, RICH, false).motionGroup).toBe("Special")
  })

  it("returns parameter fallback when no motion group matches", () => {
    for (const state of ALL_STATES) {
      const plan = resolveLive2dPlan(state, null, EMPTY, false)
      expect(plan.parameterFallback).toBe(true)
      expect(plan.motionGroup).toBeUndefined()
      expect(plan.motionIndex).toBeUndefined()
    }
  })
})

describe("resolveLive2dPlan — one-shots", () => {
  it("always uses force priority and the one-shot table", () => {
    for (const shot of ALL_SHOTS) {
      const plan = resolveLive2dPlan("idle", shot, RICH, false)
      expect(plan.priority).toBe("force")
    }
  })

  it("routes wave to Tap", () => {
    expect(resolveLive2dPlan("idle", "wave", RICH, false).motionGroup).toBe("Tap")
  })

  it("routes fed / petted / happy one-shots to TapBody", () => {
    expect(resolveLive2dPlan("idle", "fed", RICH, false).motionGroup).toBe("TapBody")
    expect(resolveLive2dPlan("idle", "petted", RICH, false).motionGroup).toBe("TapBody")
    expect(resolveLive2dPlan("happy", "happy", RICH, false).motionGroup).toBe("TapBody")
  })

  it("routes evolving / levelUp one-shots to Special", () => {
    expect(resolveLive2dPlan("idle", "evolving", RICH, false).motionGroup).toBe("Special")
    expect(resolveLive2dPlan("idle", "levelUp", RICH, false).motionGroup).toBe("Special")
  })

  it("one-shot overrides the resting state intent", () => {
    // state=sad would be idle priority, but the wave one-shot forces it.
    const plan = resolveLive2dPlan("sad", "wave", RICH, false)
    expect(plan.priority).toBe("force")
    expect(plan.motionGroup).toBe("Tap")
  })
})

describe("resolveLive2dPlan — tolerant matching", () => {
  it("matches Tap@Body against a model exposing tapbody (punctuation-insensitive)", () => {
    const caps: Live2dCapabilities = { motionGroups: ["tapbody"], expressionIds: [] }
    // greeting candidates: Tap, TapBody, Tap@Body, Idle — none literally "tapbody"
    // but TapBody canonicalizes to "tapbody".
    expect(resolveLive2dPlan("greeting", null, caps, false).motionGroup).toBe("tapbody")
  })

  it("matches case-insensitively", () => {
    const caps: Live2dCapabilities = { motionGroups: ["IDLE"], expressionIds: [] }
    expect(resolveLive2dPlan("idle", null, caps, false).motionGroup).toBe("IDLE")
  })

  it("prefers the first matching candidate in order", () => {
    const caps: Live2dCapabilities = { motionGroups: ["Idle", "TapBody"], expressionIds: [] }
    // happy order: TapBody, Tap@Body, Tap, Idle → TapBody wins over Idle.
    expect(resolveLive2dPlan("happy", null, caps, false).motionGroup).toBe("TapBody")
  })
})

describe("resolveLive2dPlan — reduced motion", () => {
  it("collapses to a still idle plan with no group or expression", () => {
    const plan = resolveLive2dPlan("happy", "levelUp", RICH, true)
    expect(plan).toEqual({ priority: "idle", parameterFallback: false })
  })

  it("ignores one-shots and rich caps under reduced motion", () => {
    for (const shot of [...ALL_SHOTS, null]) {
      const plan = resolveLive2dPlan("error", shot as PetOneShot | null, RICH, true)
      expect(plan.motionGroup).toBeUndefined()
      expect(plan.expressionId).toBeUndefined()
    }
  })
})
