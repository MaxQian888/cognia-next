import type { PetOneShot, PetVisualState } from "@/types/pet"
import { resolveLive2dPlan, resolveLive2dWalkPlan } from "./state-mapping"
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

const ALL_SHOTS: PetOneShot[] = [
  "wave",
  "happy",
  "fed",
  "petted",
  "evolving",
  "levelUp",
  "sad",
  "surprised",
  "love",
  "sleepy",
]

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

describe("resolveLive2dPlan — per-model overrides", () => {
  it("an override entry fully governs its key (group + expression + index)", () => {
    const plan = resolveLive2dPlan("happy", null, RICH, false, {
      happy: { motionGroup: "Special", motionIndex: 2, expressionId: "sleepy" },
    })
    expect(plan).toEqual({
      priority: "normal",
      parameterFallback: false,
      motionGroup: "Special",
      motionIndex: 2,
      expressionId: "sleepy",
    })
  })

  it("keeps the priority rule (one-shots force, idle states idle)", () => {
    expect(
      resolveLive2dPlan("idle", "wave", RICH, false, {
        "shot:wave": { motionGroup: "Special" },
      }).priority
    ).toBe("force")
    expect(
      resolveLive2dPlan("sleeping", null, RICH, false, {
        sleeping: { motionGroup: "Special" },
      }).priority
    ).toBe("idle")
  })

  it("an unset motionIndex means random (left undefined for the hook)", () => {
    const plan = resolveLive2dPlan("idle", null, RICH, false, {
      idle: { motionGroup: "Special" },
    })
    expect(plan.motionGroup).toBe("Special")
    expect(plan.motionIndex).toBeUndefined()
  })

  it("an empty entry is the explicit engine default (no motion, no expression)", () => {
    const plan = resolveLive2dPlan("happy", null, RICH, false, { happy: {} })
    expect(plan).toEqual({ priority: "normal", parameterFallback: true })
  })

  it("a dangling motion group falls through to the convention tables", () => {
    const plan = resolveLive2dPlan("happy", null, RICH, false, {
      happy: { motionGroup: "Gone" },
    })
    // Convention: happy → TapBody + happy expression.
    expect(plan.motionGroup).toBe("TapBody")
    expect(plan.expressionId).toBe("happy")
  })

  it("an unavailable expression is dropped while the group still applies", () => {
    const plan = resolveLive2dPlan("idle", null, RICH, false, {
      idle: { motionGroup: "Special", expressionId: "gone" },
    })
    expect(plan.motionGroup).toBe("Special")
    expect(plan.expressionId).toBeUndefined()
  })

  it("one-shot keys are namespaced — a state override never hijacks the one-shot", () => {
    const overrides = { happy: { motionGroup: "Special" } }
    // The one-shot "happy" uses the "shot:happy" key → convention applies.
    const plan = resolveLive2dPlan("idle", "happy", RICH, false, overrides)
    expect(plan.motionGroup).toBe("TapBody")
    expect(plan.priority).toBe("force")
  })

  it("reduced motion still wins over overrides", () => {
    const plan = resolveLive2dPlan("happy", null, RICH, true, {
      happy: { motionGroup: "Special" },
    })
    expect(plan).toEqual({ priority: "idle", parameterFallback: false })
  })

  it.each([...ALL_STATES])("omitted overrides leave %s identical to the convention plan", (s) => {
    expect(resolveLive2dPlan(s, null, RICH, false, undefined)).toEqual(
      resolveLive2dPlan(s, null, RICH, false)
    )
  })
})

describe("resolveLive2dWalkPlan", () => {
  it("prefers a real walk-ish group at idle priority", () => {
    const caps: Live2dCapabilities = { motionGroups: ["Idle", "Walk"], expressionIds: [] }
    expect(resolveLive2dWalkPlan(caps, false)).toEqual({
      priority: "idle",
      parameterFallback: false,
      motionGroup: "Walk",
      motionIndex: 0,
    })
  })

  it("matches walk-ish names canonically (walking / move / run)", () => {
    const caps: Live2dCapabilities = { motionGroups: ["walking"], expressionIds: [] }
    expect(resolveLive2dWalkPlan(caps, false).motionGroup).toBe("walking")
    const move: Live2dCapabilities = { motionGroups: ["Move"], expressionIds: [] }
    expect(resolveLive2dWalkPlan(move, false).motionGroup).toBe("Move")
  })

  it("falls back to Idle when no walk group exists", () => {
    expect(resolveLive2dWalkPlan(RICH, false).motionGroup).toBe("Idle")
  })

  it("parameter-falls-back when the model exposes nothing usable", () => {
    const plan = resolveLive2dWalkPlan(EMPTY, false)
    expect(plan.motionGroup).toBeUndefined()
    expect(plan.parameterFallback).toBe(true)
  })

  it("collapses under reduced motion", () => {
    expect(resolveLive2dWalkPlan(RICH, true)).toEqual({
      priority: "idle",
      parameterFallback: false,
    })
  })
})
