import {
  DEFAULT_GOAL_CONSOLE_PREFS,
  GOAL_CONSOLE_TABS,
  isGoalConsoleTab,
  resolveGoalConsolePrefs,
} from "./console-prefs"

describe("goal console-prefs", () => {
  describe("isGoalConsoleTab", () => {
    it("accepts every canonical tab", () => {
      for (const tab of GOAL_CONSOLE_TABS) expect(isGoalConsoleTab(tab)).toBe(true)
      expect(isGoalConsoleTab("overview")).toBe(true)
    })

    it("rejects unknown / nullish values", () => {
      expect(isGoalConsoleTab("nope")).toBe(false)
      expect(isGoalConsoleTab(null)).toBe(false)
      expect(isGoalConsoleTab(undefined)).toBe(false)
      expect(isGoalConsoleTab("")).toBe(false)
    })
  })

  describe("DEFAULT_GOAL_CONSOLE_PREFS", () => {
    it("lands on the overview section by default", () => {
      expect(DEFAULT_GOAL_CONSOLE_PREFS.defaultTab).toBe("overview")
    })
  })

  describe("resolveGoalConsolePrefs", () => {
    it("returns the hard defaults for nullish input", () => {
      expect(resolveGoalConsolePrefs(null)).toEqual(DEFAULT_GOAL_CONSOLE_PREFS)
      expect(resolveGoalConsolePrefs(undefined)).toEqual(DEFAULT_GOAL_CONSOLE_PREFS)
      expect(resolveGoalConsolePrefs({})).toEqual(DEFAULT_GOAL_CONSOLE_PREFS)
    })

    it("applies a full override", () => {
      expect(
        resolveGoalConsolePrefs({
          defaultTab: "analytics",
          openGoalsSort: "tokens",
          openGoalsDir: "asc",
        })
      ).toEqual({ defaultTab: "analytics", openGoalsSort: "tokens", openGoalsDir: "asc" })
    })

    it("merges a partial override over the defaults", () => {
      expect(resolveGoalConsolePrefs({ defaultTab: "templates" })).toEqual({
        ...DEFAULT_GOAL_CONSOLE_PREFS,
        defaultTab: "templates",
      })
    })

    it("ignores malformed enum values and falls back per-field", () => {
      const resolved = resolveGoalConsolePrefs({
        defaultTab: "bogus" as never,
        openGoalsSort: "wat" as never,
        openGoalsDir: "sideways" as never,
      })
      expect(resolved).toEqual(DEFAULT_GOAL_CONSOLE_PREFS)
    })
  })
})
