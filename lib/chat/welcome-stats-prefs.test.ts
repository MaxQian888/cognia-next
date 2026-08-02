import {
  DEFAULT_WELCOME_STATS_PREFS,
  isWelcomeStatId,
  resolveWelcomeStatsPrefs,
  WELCOME_STAT_IDS,
  WELCOME_STATS_RANGE_DAYS,
  WELCOME_STATS_VIEWS,
} from "./welcome-stats-prefs"

describe("isWelcomeStatId", () => {
  it("accepts known ids and rejects everything else", () => {
    expect(isWelcomeStatId("sessions")).toBe(true)
    expect(isWelcomeStatId("topModel")).toBe(true)
    expect(isWelcomeStatId("nope")).toBe(false)
    expect(isWelcomeStatId(undefined)).toBe(false)
    expect(isWelcomeStatId(7)).toBe(false)
  })
})

describe("resolveWelcomeStatsPrefs", () => {
  it("falls back to the defaults for null / undefined / empty", () => {
    expect(resolveWelcomeStatsPrefs(null)).toEqual(DEFAULT_WELCOME_STATS_PREFS)
    expect(resolveWelcomeStatsPrefs(undefined)).toEqual(DEFAULT_WELCOME_STATS_PREFS)
    expect(resolveWelcomeStatsPrefs({})).toEqual(DEFAULT_WELCOME_STATS_PREFS)
  })

  it("returns a fresh tile array so callers cannot mutate the defaults", () => {
    const prefs = resolveWelcomeStatsPrefs(null)
    prefs.tiles.push("longestStreak")
    expect(DEFAULT_WELCOME_STATS_PREFS.tiles).not.toContain("longestStreak")
  })

  it("keeps a stored disable flag", () => {
    expect(resolveWelcomeStatsPrefs({ enabled: false }).enabled).toBe(false)
    expect(resolveWelcomeStatsPrefs({ heatmap: false }).heatmap).toBe(false)
  })

  it("accepts each offered range and rejects any other", () => {
    for (const days of WELCOME_STATS_RANGE_DAYS) {
      expect(resolveWelcomeStatsPrefs({ rangeDays: days }).rangeDays).toBe(days)
    }
    expect(resolveWelcomeStatsPrefs({ rangeDays: 365 }).rangeDays).toBe(
      DEFAULT_WELCOME_STATS_PREFS.rangeDays
    )
    expect(resolveWelcomeStatsPrefs({ rangeDays: "30" as unknown as number }).rangeDays).toBe(
      DEFAULT_WELCOME_STATS_PREFS.rangeDays
    )
  })

  it("accepts each view and rejects an unknown one", () => {
    for (const view of WELCOME_STATS_VIEWS) {
      expect(resolveWelcomeStatsPrefs({ view }).view).toBe(view)
    }
    expect(resolveWelcomeStatsPrefs({ view: "charts" as never }).view).toBe(
      DEFAULT_WELCOME_STATS_PREFS.view
    )
  })

  it("drops unknown tile ids instead of rendering them", () => {
    const prefs = resolveWelcomeStatsPrefs({ tiles: ["sessions", "wat", "topModel"] })
    expect(prefs.tiles).toEqual(["sessions", "topModel"])
  })

  it("re-sorts stored tiles into canonical order and de-duplicates", () => {
    const prefs = resolveWelcomeStatsPrefs({ tiles: ["topModel", "sessions", "sessions"] })
    expect(prefs.tiles).toEqual(["sessions", "topModel"])
  })

  it("honours an explicitly emptied tile list", () => {
    // Every tile unchecked is a real choice, not a missing value — it must not
    // silently restore the defaults.
    expect(resolveWelcomeStatsPrefs({ tiles: [] }).tiles).toEqual([])
  })

  it("restores the defaults when the stored tile list is not an array", () => {
    expect(resolveWelcomeStatsPrefs({ tiles: "sessions" as unknown as string[] }).tiles).toEqual(
      DEFAULT_WELCOME_STATS_PREFS.tiles
    )
  })

  it("ships defaults that are all valid ids", () => {
    for (const id of DEFAULT_WELCOME_STATS_PREFS.tiles) {
      expect(WELCOME_STAT_IDS).toContain(id)
    }
    expect(WELCOME_STATS_RANGE_DAYS).toContain(DEFAULT_WELCOME_STATS_PREFS.rangeDays)
  })
})
