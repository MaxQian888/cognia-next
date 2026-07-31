import type { PetCareState, PetNeeds } from "@/types/pet"
import { DEFAULT_CARE_STATE } from "@/types/pet"
import {
  UNWELL_NEED_THRESHOLD,
  UNWELL_SUSTAIN_MS,
  WELL_RECOVERY_THRESHOLD,
  deriveCareState,
} from "./condition"

const NOW = 10_000_000_000

const needs = (energy: number, mood: number, bond = 50): PetNeeds => ({
  energy,
  mood,
  bond,
  lastTickAt: new Date(NOW).toISOString(),
})

describe("deriveCareState", () => {
  it("stays well with healthy needs and no prior state", () => {
    const r = deriveCareState({ needs: needs(80, 80), now: NOW })
    expect(r.care.condition).toBe("well")
    expect(r.care.lowSince).toBeNull()
    expect(r.becameUnwell).toBe(false)
  })

  it("arms the low timer when a need first drops, but does not become unwell yet", () => {
    const r = deriveCareState({ needs: needs(UNWELL_NEED_THRESHOLD - 5, 80), now: NOW })
    expect(r.care.lowSince).toBe(NOW)
    expect(r.care.condition).toBe("well")
    expect(r.becameUnwell).toBe(false)
  })

  it("becomes unwell only after the sustain window elapses", () => {
    const prev: PetCareState = { ...DEFAULT_CARE_STATE, lowSince: NOW }
    const justBefore = deriveCareState({
      needs: needs(10, 80),
      prev,
      now: NOW + UNWELL_SUSTAIN_MS - 1,
    })
    expect(justBefore.care.condition).toBe("well")

    const atThreshold = deriveCareState({
      needs: needs(10, 80),
      prev,
      now: NOW + UNWELL_SUSTAIN_MS,
    })
    expect(atThreshold.care.condition).toBe("unwell")
    expect(atThreshold.becameUnwell).toBe(true)
    expect(atThreshold.care.everUnwell).toBe(true)
  })

  it("is idempotent — re-deriving from the unwell result keeps it unwell, flag false", () => {
    const first = deriveCareState({
      needs: needs(10, 80),
      prev: { ...DEFAULT_CARE_STATE, lowSince: NOW },
      now: NOW + UNWELL_SUSTAIN_MS,
    })
    const again = deriveCareState({
      needs: needs(10, 80),
      prev: first.care,
      now: NOW + UNWELL_SUSTAIN_MS + 1000,
    })
    expect(again.care.condition).toBe("unwell")
    expect(again.becameUnwell).toBe(false)
  })

  it("recovers to well once both needs clear the recovery threshold", () => {
    const unwell: PetCareState = {
      ...DEFAULT_CARE_STATE,
      condition: "unwell",
      lowSince: NOW,
      everUnwell: true,
      notifiedAt: NOW,
    }
    const r = deriveCareState({
      needs: needs(WELL_RECOVERY_THRESHOLD, WELL_RECOVERY_THRESHOLD),
      prev: unwell,
      now: NOW + 100,
    })
    expect(r.care.condition).toBe("well")
    expect(r.recovered).toBe(true)
    expect(r.care.lowSince).toBeNull()
    expect(r.care.notifiedAt).toBeNull()
    expect(r.care.everUnwell).toBe(true) // sticky
  })

  it("does not flap inside the hysteresis band", () => {
    // energy rises to 30 (above 25 but below 45) while unwell → stays unwell.
    const unwell: PetCareState = {
      ...DEFAULT_CARE_STATE,
      condition: "unwell",
      lowSince: NOW,
      everUnwell: true,
    }
    const r = deriveCareState({ needs: needs(30, 30), prev: unwell, now: NOW + 100 })
    expect(r.care.condition).toBe("unwell")
    expect(r.recovered).toBe(false)
  })

  it("moves careQuality via EMA toward the average of needs", () => {
    const prev: PetCareState = { ...DEFAULT_CARE_STATE, careQuality: 100 }
    const r = deriveCareState({ needs: needs(0, 0, 0), prev, now: NOW })
    // EMA from 100 toward 0 with 0.9 inertia → 90.
    expect(r.care.careQuality).toBe(90)
  })

  it("keeps careQuality within [0, 100]", () => {
    const r = deriveCareState({
      needs: needs(100, 100, 100),
      prev: { ...DEFAULT_CARE_STATE, careQuality: 100 },
      now: NOW,
    })
    expect(r.care.careQuality).toBeLessThanOrEqual(100)
    expect(r.care.careQuality).toBeGreaterThanOrEqual(0)
  })
})
