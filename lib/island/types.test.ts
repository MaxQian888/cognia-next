import {
  DEFAULT_ISLAND_DETAIL_VISIBILITY,
  DEFAULT_ISLAND_PREFERENCES,
  ISLAND_DETAIL_VISIBILITIES,
  ISLAND_STATUS_RANK,
  mergeIslandPreferences,
  normalizeDetailVisibility,
} from "./types"

describe("normalizeDetailVisibility", () => {
  it("keeps every known value", () => {
    for (const value of ISLAND_DETAIL_VISIBILITIES) {
      expect(normalizeDetailVisibility(value)).toBe(value)
    }
  })

  it("migrates an old or unknown value to the most private default", () => {
    expect(DEFAULT_ISLAND_DETAIL_VISIBILITY).toBe("click-to-reveal")
    for (const value of [undefined, null, "", "always", 3, {}, "hover-detail"]) {
      expect(normalizeDetailVisibility(value)).toBe("click-to-reveal")
    }
  })
})

describe("mergeIslandPreferences", () => {
  it("fills in the default for a missing or corrupt blob", () => {
    expect(mergeIslandPreferences(undefined)).toEqual(DEFAULT_ISLAND_PREFERENCES)
    expect(mergeIslandPreferences({ detailVisibility: "nonsense" })).toEqual(
      DEFAULT_ISLAND_PREFERENCES
    )
  })

  it("keeps an explicit opt-in", () => {
    expect(mergeIslandPreferences({ detailVisibility: "summary-only" })).toEqual({
      detailVisibility: "summary-only",
    })
  })
})

describe("island contracts", () => {
  it("ranks human-blocking work ahead of everything else", () => {
    expect(ISLAND_STATUS_RANK.blocked).toBeLessThan(ISLAND_STATUS_RANK.failed)
    expect(ISLAND_STATUS_RANK.failed).toBeLessThan(ISLAND_STATUS_RANK.working)
    expect(ISLAND_STATUS_RANK.working).toBeLessThan(ISLAND_STATUS_RANK.done)
    expect(ISLAND_STATUS_RANK.done).toBeLessThan(ISLAND_STATUS_RANK.idle)
    expect(ISLAND_STATUS_RANK.idle).toBeLessThan(ISLAND_STATUS_RANK.stale)
  })
})
