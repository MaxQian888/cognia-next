import { applyPetEvent } from "./apply-event"
import { createDefaultProfile } from "@/lib/pet/defaults"
import type { PetEvent, PetProfile } from "@/types/pet"

function profile(overrides: Partial<PetProfile> = {}): PetProfile {
  return {
    ...createDefaultProfile("acct", 0),
    soul: { name: "Boba", personality: "x", hatchDate: "" },
    stage: "baby",
    ...overrides,
  }
}

function event(kind: PetEvent["kind"], xp?: number): PetEvent {
  return { source: "user", kind, xp, at: 1 }
}

describe("applyPetEvent", () => {
  it("awards XP from the table and recomputes level/stage", () => {
    const res = applyPetEvent(profile({ xp: 90 }), event("goalComplete"), 1000)
    expect(res.profile.xp).toBe(115) // 90 + 25
    expect(res.profile.level).toBe(2)
    expect(res.leveledUpTo).toBe(2)
    expect(res.oneShots).toContain("levelUp")
    expect(res.oneShots).toContain("happy") // goalComplete celebrates
  })

  it("plays the feed one-shot and restores energy on feed", () => {
    const res = applyPetEvent(
      profile({ needs: { energy: 50, mood: 50, bond: 50, lastTickAt: new Date(0).toISOString() } }),
      event("fed"),
      0
    )
    expect(res.oneShots).toContain("fed")
    expect(res.profile.needs.energy).toBeGreaterThan(50)
  })

  it("evolves when the stage changes (and is not an egg)", () => {
    // jump from level 4 (baby) into juvenile by crossing 800 → 1000 xp boundary
    const res = applyPetEvent(
      profile({ xp: 990, level: 4, stage: "baby" }),
      event("goalComplete", 200),
      0
    )
    expect(res.profile.level).toBeGreaterThanOrEqual(5)
    expect(res.profile.stage).toBe("juvenile")
    expect(res.evolvedTo).toBe("juvenile")
    expect(res.oneShots).toContain("evolving")
  })

  it("keeps the egg stage and never evolves while unhatched", () => {
    const res = applyPetEvent(
      profile({ soul: null, stage: "egg", xp: 0 }),
      event("goalComplete", 500),
      0
    )
    expect(res.profile.stage).toBe("egg")
    expect(res.evolvedTo).toBeNull()
  })

  it("does not change needs for non-interaction events", () => {
    const p = profile()
    const res = applyPetEvent(p, event("thinking"), 5000)
    expect(res.profile.needs).toBe(p.needs)
    expect(res.oneShots).toEqual([])
  })

  it("grows stats from a work event and reports the grown keys", () => {
    const res = applyPetEvent(profile(), event("goalComplete"), 1000)
    expect(res.statProgress.patience).toBeGreaterThan(0)
    expect(res.statProgress.wisdom).toBeGreaterThan(0)
    expect(res.grewStats).toEqual(expect.arrayContaining(["patience", "wisdom"]))
    expect(res.profile.statProgress).toEqual(res.statProgress)
  })

  it("accumulates stat growth on top of prior progress", () => {
    const prior = profile({
      statProgress: { debugging: 0, patience: 10, chaos: 0, wisdom: 0, snark: 0 },
    })
    const res = applyPetEvent(prior, event("goalComplete"), 1000)
    expect(res.statProgress.patience).toBeCloseTo(11.5) // 10 + 1.5
  })

  it("derives a care state and reports no transition for a healthy pet", () => {
    const res = applyPetEvent(profile(), event("thinking"), 1000)
    expect(res.care.condition).toBe("well")
    expect(res.becameUnwell).toBe(false)
    expect(res.recovered).toBe(false)
    expect(res.profile.care).toEqual(res.care)
  })

  it("flags becameUnwell once sustained low needs cross the threshold", () => {
    const start = 1_000_000
    const lowNeeds = {
      energy: 5,
      mood: 5,
      bond: 50,
      lastTickAt: new Date(start).toISOString(),
    }
    const p = profile({
      needs: lowNeeds,
      care: {
        lowSince: start,
        condition: "well",
        notifiedAt: null,
        everUnwell: false,
        careQuality: 50,
      },
    })
    const res = applyPetEvent(p, event("idle"), start + 7 * 3_600_000)
    expect(res.becameUnwell).toBe(true)
    expect(res.care.condition).toBe("unwell")
  })
})
