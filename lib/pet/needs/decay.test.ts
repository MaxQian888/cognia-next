import { applyDecay, applyInteraction, applyNeedEffect, INTERACTION_EFFECTS } from "./decay"
import type { PetNeeds } from "@/types/pet"

const HOUR = 3_600_000

function needs(partial: Partial<PetNeeds> = {}): PetNeeds {
  return { energy: 100, mood: 100, bond: 100, lastTickAt: new Date(0).toISOString(), ...partial }
}

describe("applyDecay", () => {
  it("decays each need by its hourly rate and advances the tick", () => {
    const out = applyDecay(needs(), HOUR)
    expect(out.energy).toBeCloseTo(96) // 4/hr
    expect(out.mood).toBeCloseTo(97.5) // 2.5/hr
    expect(out.bond).toBeCloseTo(99.5) // 0.5/hr
    expect(out.lastTickAt).toBe(new Date(HOUR).toISOString())
  })

  it("never falls below the floor and never goes negative", () => {
    const out = applyDecay(needs({ energy: 10 }), HOUR * 1000)
    expect(out.energy).toBe(0)
    expect(out.mood).toBe(0)
  })

  it("does not change values when no time has passed", () => {
    const out = applyDecay(needs(), 0)
    expect(out.energy).toBe(100)
  })
})

describe("applyInteraction", () => {
  it("settles decay then restores energy on feed", () => {
    const out = applyInteraction(needs({ energy: 50 }), "fed", HOUR)
    // 50 - 4 (decay) + 25 (feed) = 71
    expect(out.energy).toBeCloseTo(71)
  })

  it("clamps restored values at 100", () => {
    const out = applyInteraction(needs({ energy: 99 }), "fed", 0)
    expect(out.energy).toBe(100)
  })

  it("play costs a little energy but lifts mood", () => {
    const out = applyInteraction(needs({ mood: 40, energy: 80 }), "played", 0)
    expect(out.mood).toBe(65)
    expect(out.energy).toBe(74)
  })

  it("exposes the effect table", () => {
    expect(INTERACTION_EFFECTS.petted.bond).toBeGreaterThan(0)
  })

  it("sleep deeply restores energy", () => {
    const out = applyInteraction(needs({ energy: 30, mood: 50 }), "slept", 0)
    expect(out.energy).toBe(70)
    expect(out.mood).toBe(56)
  })

  it("clean lifts mood and a little bond", () => {
    const out = applyInteraction(needs({ mood: 50, bond: 50 }), "cleaned", 0)
    expect(out.mood).toBe(62)
    expect(out.bond).toBe(53)
  })

  it("treat boosts bond + mood but costs a little energy", () => {
    const out = applyInteraction(needs({ mood: 50, bond: 50, energy: 50 }), "treated", 0)
    expect(out.bond).toBe(56)
    expect(out.mood).toBe(58)
    expect(out.energy).toBe(48)
  })
})

describe("applyNeedEffect", () => {
  it("settles decay then adds an arbitrary effect, clamped", () => {
    const out = applyNeedEffect(needs({ energy: 50 }), { energy: 45, mood: 10, bond: 2 }, HOUR)
    // energy 50 − 4 (decay) + 45 = 91; mood 100 − 2.5 + 10 → clamp 100.
    expect(out.energy).toBeCloseTo(91)
    expect(out.mood).toBe(100)
    expect(out.lastTickAt).toBe(new Date(HOUR).toISOString())
  })

  it("treats missing keys as zero and clamps negatives at 0", () => {
    const out = applyNeedEffect(needs({ energy: 2, mood: 50 }), { energy: -10 }, 0)
    expect(out.energy).toBe(0)
    expect(out.mood).toBe(50)
  })

  it("matches applyInteraction bit-for-bit for a table effect", () => {
    const viaInteraction = applyInteraction(needs({ energy: 50 }), "fed", HOUR)
    const viaEffect = applyNeedEffect(needs({ energy: 50 }), INTERACTION_EFFECTS.fed, HOUR)
    expect(viaEffect).toEqual(viaInteraction)
  })
})
