import {
  clampEnabledWarnThreshold,
  DEFAULT_SKILL_PANEL_PREFS,
  resolveSkillPanelPrefs,
  SKILL_ENABLED_WARN_MAX,
  type PartialSkillPanelPrefs,
} from "./preferences"

describe("resolveSkillPanelPrefs", () => {
  it("returns a fresh copy of defaults for null/undefined", () => {
    expect(resolveSkillPanelPrefs(null)).toEqual(DEFAULT_SKILL_PANEL_PREFS)
    expect(resolveSkillPanelPrefs(undefined)).toEqual(DEFAULT_SKILL_PANEL_PREFS)
    // Must not be the same reference (callers mutate their copy freely).
    expect(resolveSkillPanelPrefs(null)).not.toBe(DEFAULT_SKILL_PANEL_PREFS)
  })

  it("keeps current look by default (description on, others off)", () => {
    expect(DEFAULT_SKILL_PANEL_PREFS.showDescription).toBe(true)
    expect(DEFAULT_SKILL_PANEL_PREFS.showTags).toBe(false)
    expect(DEFAULT_SKILL_PANEL_PREFS.density).toBe("comfortable")
    expect(DEFAULT_SKILL_PANEL_PREFS.viewMode).toBe("list")
    expect(DEFAULT_SKILL_PANEL_PREFS.autoEnableNew).toBe(true)
  })

  it("merges partial values over defaults", () => {
    const raw: PartialSkillPanelPrefs = {
      density: "compact",
      viewMode: "grid",
      showTags: true,
      defaultTab: "browse",
      defaultSort: "usage",
      autoEnableNew: false,
    }
    const resolved = resolveSkillPanelPrefs(raw)
    expect(resolved.density).toBe("compact")
    expect(resolved.viewMode).toBe("grid")
    expect(resolved.showTags).toBe(true)
    expect(resolved.defaultTab).toBe("browse")
    expect(resolved.defaultSort).toBe("usage")
    expect(resolved.autoEnableNew).toBe(false)
    // Untouched fields fall back to defaults.
    expect(resolved.showDescription).toBe(true)
    expect(resolved.defaultStatusFilter).toBe("all")
  })

  it("preserves explicit false booleans (does not coerce to default)", () => {
    const resolved = resolveSkillPanelPrefs({ showDescription: false, autoEnableNew: false })
    expect(resolved.showDescription).toBe(false)
    expect(resolved.autoEnableNew).toBe(false)
  })

  it("falls back on invalid enum values", () => {
    const resolved = resolveSkillPanelPrefs({
      density: "cozy" as never,
      viewMode: "table" as never,
      defaultTab: "nope" as never,
      defaultSort: "random" as never,
      defaultStatusFilter: "bogus" as never,
    })
    expect(resolved.density).toBe("comfortable")
    expect(resolved.viewMode).toBe("list")
    expect(resolved.defaultTab).toBe("my-skills")
    expect(resolved.defaultSort).toBe("name")
    expect(resolved.defaultStatusFilter).toBe("all")
  })

  it("accepts valid non-default status filter", () => {
    expect(resolveSkillPanelPrefs({ defaultStatusFilter: "enabled" }).defaultStatusFilter).toBe(
      "enabled"
    )
  })

  it("clamps the enabled warn threshold", () => {
    expect(resolveSkillPanelPrefs({ enabledWarnThreshold: -5 }).enabledWarnThreshold).toBe(0)
    expect(resolveSkillPanelPrefs({ enabledWarnThreshold: 3.9 }).enabledWarnThreshold).toBe(3)
    expect(resolveSkillPanelPrefs({ enabledWarnThreshold: 9999 }).enabledWarnThreshold).toBe(
      SKILL_ENABLED_WARN_MAX
    )
  })
})

describe("clampEnabledWarnThreshold", () => {
  it("returns 0 for non-numbers and non-positive values", () => {
    expect(clampEnabledWarnThreshold(undefined)).toBe(0)
    expect(clampEnabledWarnThreshold("5" as never)).toBe(0)
    expect(clampEnabledWarnThreshold(NaN)).toBe(0)
    expect(clampEnabledWarnThreshold(0)).toBe(0)
    expect(clampEnabledWarnThreshold(-1)).toBe(0)
  })

  it("floors and caps", () => {
    expect(clampEnabledWarnThreshold(4.7)).toBe(4)
    expect(clampEnabledWarnThreshold(SKILL_ENABLED_WARN_MAX + 50)).toBe(SKILL_ENABLED_WARN_MAX)
  })
})
