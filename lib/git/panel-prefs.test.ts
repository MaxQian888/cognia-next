import {
  AUTO_FETCH_INTERVAL_MAX,
  AUTO_FETCH_INTERVAL_MIN,
  clampAutoFetchInterval,
  DEFAULT_SOURCE_CONTROL_PANEL_PREFS,
  isDefaultSourceControlPanelPrefs,
  resolveSourceControlPanelPrefs,
} from "./panel-prefs"

describe("resolveSourceControlPanelPrefs", () => {
  it("returns a fresh copy of the defaults for undefined / null", () => {
    expect(resolveSourceControlPanelPrefs(undefined)).toEqual(DEFAULT_SOURCE_CONTROL_PANEL_PREFS)
    expect(resolveSourceControlPanelPrefs(null)).toEqual(DEFAULT_SOURCE_CONTROL_PANEL_PREFS)
    // A fresh copy, not the shared const (so callers can't mutate the default).
    expect(resolveSourceControlPanelPrefs(undefined)).not.toBe(DEFAULT_SOURCE_CONTROL_PANEL_PREFS)
  })

  it("reflects a valid stored partial and fills the rest from defaults", () => {
    const resolved = resolveSourceControlPanelPrefs({
      diffView: "inline",
      postCommit: "sync",
      confirmDiscard: false,
    })
    expect(resolved.diffView).toBe("inline")
    expect(resolved.postCommit).toBe("sync")
    expect(resolved.confirmDiscard).toBe(false)
    // Untouched fields fall back to defaults.
    expect(resolved.confirmForcePush).toBe(true)
    expect(resolved.branchSort).toBe("default")
  })

  it("drops unknown enum values back to the default", () => {
    const resolved = resolveSourceControlPanelPrefs({
      diffView: "bogus",
      postCommit: "detonate",
      branchSort: "chronological",
      defaultTimelineView: "matrix",
    })
    expect(resolved.diffView).toBe(DEFAULT_SOURCE_CONTROL_PANEL_PREFS.diffView)
    expect(resolved.postCommit).toBe(DEFAULT_SOURCE_CONTROL_PANEL_PREFS.postCommit)
    expect(resolved.branchSort).toBe(DEFAULT_SOURCE_CONTROL_PANEL_PREFS.branchSort)
    expect(resolved.defaultTimelineView).toBe(
      DEFAULT_SOURCE_CONTROL_PANEL_PREFS.defaultTimelineView
    )
  })

  it("clamps an out-of-range auto-fetch interval and keeps the default when absent", () => {
    expect(
      resolveSourceControlPanelPrefs({ autoFetchIntervalMinutes: 0 }).autoFetchIntervalMinutes
    ).toBe(AUTO_FETCH_INTERVAL_MIN)
    expect(
      resolveSourceControlPanelPrefs({ autoFetchIntervalMinutes: 999 }).autoFetchIntervalMinutes
    ).toBe(AUTO_FETCH_INTERVAL_MAX)
    expect(
      resolveSourceControlPanelPrefs({ autoFetchIntervalMinutes: 2.7 }).autoFetchIntervalMinutes
    ).toBe(2)
    expect(resolveSourceControlPanelPrefs({}).autoFetchIntervalMinutes).toBe(
      DEFAULT_SOURCE_CONTROL_PANEL_PREFS.autoFetchIntervalMinutes
    )
  })

  it("preserves explicit boolean values including false", () => {
    const resolved = resolveSourceControlPanelPrefs({
      ignoreWhitespace: true,
      confirmForcePush: false,
      smartCommit: true,
      autoFetch: true,
    })
    expect(resolved.ignoreWhitespace).toBe(true)
    expect(resolved.confirmForcePush).toBe(false)
    expect(resolved.smartCommit).toBe(true)
    expect(resolved.autoFetch).toBe(true)
  })
})

describe("clampAutoFetchInterval", () => {
  it("floors, bounds, and falls back on garbage", () => {
    expect(clampAutoFetchInterval(15)).toBe(15)
    expect(clampAutoFetchInterval(-5)).toBe(AUTO_FETCH_INTERVAL_MIN)
    expect(clampAutoFetchInterval(1000)).toBe(AUTO_FETCH_INTERVAL_MAX)
    expect(clampAutoFetchInterval("nope")).toBe(
      DEFAULT_SOURCE_CONTROL_PANEL_PREFS.autoFetchIntervalMinutes
    )
    expect(clampAutoFetchInterval(Number.NaN)).toBe(
      DEFAULT_SOURCE_CONTROL_PANEL_PREFS.autoFetchIntervalMinutes
    )
  })
})

describe("isDefaultSourceControlPanelPrefs", () => {
  it("is true for the resolved defaults", () => {
    expect(isDefaultSourceControlPanelPrefs(resolveSourceControlPanelPrefs(undefined))).toBe(true)
  })

  it("is false once any knob differs", () => {
    expect(
      isDefaultSourceControlPanelPrefs(resolveSourceControlPanelPrefs({ diffView: "inline" }))
    ).toBe(false)
    expect(
      isDefaultSourceControlPanelPrefs(
        resolveSourceControlPanelPrefs({ autoFetchIntervalMinutes: 30 })
      )
    ).toBe(false)
  })
})
