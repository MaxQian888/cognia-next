import { DEFAULT_CARE_STATE, normalizeCareState, type PetCareState } from "./care"

describe("DEFAULT_CARE_STATE", () => {
  it("is a well, never-unwell, neutral-quality pet", () => {
    expect(DEFAULT_CARE_STATE).toEqual({
      lowSince: null,
      condition: "well",
      notifiedAt: null,
      everUnwell: false,
      careQuality: 50,
    })
  })
})

describe("normalizeCareState", () => {
  it("returns defaults for undefined", () => {
    expect(normalizeCareState()).toEqual(DEFAULT_CARE_STATE)
  })

  it("passes through a full valid state", () => {
    const full: PetCareState = {
      lowSince: 123,
      condition: "unwell",
      notifiedAt: 456,
      everUnwell: true,
      careQuality: 42,
    }
    expect(normalizeCareState(full)).toEqual(full)
  })

  it("coerces an unknown condition to well", () => {
    expect(normalizeCareState({ condition: "weird" as PetCareState["condition"] }).condition).toBe(
      "well"
    )
  })

  it("clamps careQuality into [0, 100]", () => {
    expect(normalizeCareState({ careQuality: 150 }).careQuality).toBe(100)
    expect(normalizeCareState({ careQuality: -5 }).careQuality).toBe(0)
  })

  it("falls back to the default careQuality when non-finite", () => {
    expect(normalizeCareState({ careQuality: Number.NaN }).careQuality).toBe(50)
  })

  it("treats non-numeric timestamps as null", () => {
    const out = normalizeCareState({
      lowSince: undefined,
      notifiedAt: undefined,
    })
    expect(out.lowSince).toBeNull()
    expect(out.notifiedAt).toBeNull()
  })
})
