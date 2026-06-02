import { resolvePetMotion } from "./motion-spec"
import type { PetOneShot, PetVisualState } from "@/types/pet"

const STATES: PetVisualState[] = [
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
const SHOTS: PetOneShot[] = ["wave", "happy", "fed", "petted", "evolving", "levelUp"]

describe("resolvePetMotion", () => {
  it("returns a well-formed spec for every visual state", () => {
    for (const state of STATES) {
      const spec = resolvePetMotion(state, null, false, "dot")
      expect(spec.body.scale.length).toBeGreaterThan(0)
      expect(spec.durationSec).toBeGreaterThan(0)
      expect(["neutral", "smile", "grin", "open", "frown", "flat", "o"]).toContain(spec.mouth)
    }
  })

  it("keeps the bones eyes for neutral states but overrides for strong emotions", () => {
    expect(resolvePetMotion("idle", null, false, "dot").eyes).toBe("dot")
    expect(resolvePetMotion("idle", null, false, "star").eyes).toBe("star")
    expect(resolvePetMotion("sleeping", null, false, "dot").eyes).toBe("sleepy")
    expect(resolvePetMotion("error", null, false, "dot").eyes).toBe("spiral")
  })

  it("applies one-shot overrides (non-looping) over the base state", () => {
    for (const shot of SHOTS) {
      const spec = resolvePetMotion("idle", shot, false, "dot")
      expect(spec.loop).toBe(false)
      expect(spec.durationSec).toBeGreaterThan(0)
    }
    expect(resolvePetMotion("idle", "evolving", false, "dot").body.rotate).toContain(360)
  })

  it("collapses all motion to resting values when reducedMotion is set", () => {
    const spec = resolvePetMotion("happy", null, true, "dot")
    expect(spec.loop).toBe(false)
    expect(spec.body.scale).toHaveLength(1)
    expect(spec.body.y).toEqual([0])
    expect(spec.body.x).toEqual([0])
    expect(spec.body.rotate).toEqual([0])
    // expression is still emotional even when still
    expect(spec.mouth).toBe("grin")
  })

  it("reduced motion still disables a one-shot's looping and movement", () => {
    const spec = resolvePetMotion("idle", "levelUp", true, "wide")
    expect(spec.loop).toBe(false)
    expect(spec.body.y).toEqual([0])
  })
})
