import {
  DEFAULT_GOAL_CONSOLE_PREFS,
  GOAL_CONFIG_SECTIONS,
  GOAL_CONSOLE_ROUTE,
  GOAL_CONSOLE_TABS,
  goalConsoleHref,
  isGoalConfigSection,
  isGoalConsoleTab,
  resolveGoalConsoleLocation,
  resolveGoalConsolePrefs,
} from "./console-prefs"

describe("goal console-prefs", () => {
  describe("tabs", () => {
    it("orders the tabs overview · history · analytics · config", () => {
      expect(GOAL_CONSOLE_TABS).toEqual(["overview", "history", "analytics", "config"])
    })

    it("accepts every canonical tab", () => {
      for (const tab of GOAL_CONSOLE_TABS) expect(isGoalConsoleTab(tab)).toBe(true)
    })

    it("rejects retired, unknown and nullish values", () => {
      expect(isGoalConsoleTab("templates")).toBe(false)
      expect(isGoalConsoleTab("defaults")).toBe(false)
      expect(isGoalConsoleTab("tracker")).toBe(false)
      expect(isGoalConsoleTab("nope")).toBe(false)
      expect(isGoalConsoleTab(null)).toBe(false)
      expect(isGoalConsoleTab(undefined)).toBe(false)
      expect(isGoalConsoleTab("")).toBe(false)
    })
  })

  describe("config sections", () => {
    it("lists the config blocks in render order", () => {
      expect(GOAL_CONFIG_SECTIONS).toEqual(["defaults", "templates", "tracker", "console"])
    })

    it("guards section values", () => {
      for (const s of GOAL_CONFIG_SECTIONS) expect(isGoalConfigSection(s)).toBe(true)
      expect(isGoalConfigSection("overview")).toBe(false)
      expect(isGoalConfigSection(null)).toBe(false)
      expect(isGoalConfigSection(undefined)).toBe(false)
    })
  })

  describe("resolveGoalConsoleLocation", () => {
    it("does not treat inherited object names as retired tabs", () => {
      expect(resolveGoalConsoleLocation("constructor")).toBeNull()
      expect(resolveGoalConsoleLocation("toString")).toBeNull()
    })

    it("resolves a current tab to itself", () => {
      expect(resolveGoalConsoleLocation("overview")).toEqual({ tab: "overview" })
      expect(resolveGoalConsoleLocation("history")).toEqual({ tab: "history" })
      expect(resolveGoalConsoleLocation("analytics")).toEqual({ tab: "analytics" })
      expect(resolveGoalConsoleLocation("config")).toEqual({ tab: "config" })
    })

    it("maps each retired tab to its config block", () => {
      expect(resolveGoalConsoleLocation("templates")).toEqual({
        tab: "config",
        section: "templates",
      })
      expect(resolveGoalConsoleLocation("defaults")).toEqual({ tab: "config", section: "defaults" })
      expect(resolveGoalConsoleLocation("tracker")).toEqual({ tab: "config", section: "tracker" })
    })

    it("a retired tab wins over an explicit section", () => {
      expect(resolveGoalConsoleLocation("tracker", "console")).toEqual({
        tab: "config",
        section: "tracker",
      })
    })

    it("carries a valid section on the config tab", () => {
      expect(resolveGoalConsoleLocation("config", "console")).toEqual({
        tab: "config",
        section: "console",
      })
    })

    it("drops an invalid section, and any section on a non-config tab", () => {
      expect(resolveGoalConsoleLocation("config", "bogus")).toEqual({ tab: "config" })
      expect(resolveGoalConsoleLocation("config", null)).toEqual({ tab: "config" })
      expect(resolveGoalConsoleLocation("history", "templates")).toEqual({ tab: "history" })
    })

    it("returns null for missing or unknown tabs", () => {
      expect(resolveGoalConsoleLocation(null)).toBeNull()
      expect(resolveGoalConsoleLocation(undefined)).toBeNull()
      expect(resolveGoalConsoleLocation("")).toBeNull()
      expect(resolveGoalConsoleLocation("bogus", "templates")).toBeNull()
    })
  })

  describe("goalConsoleHref", () => {
    it("is the bare route with no place", () => {
      expect(goalConsoleHref()).toBe(GOAL_CONSOLE_ROUTE)
      expect(goalConsoleHref({})).toBe("/goals")
    })

    it("sets the tab", () => {
      expect(goalConsoleHref({ tab: "history" })).toBe("/goals?tab=history")
    })

    it("sets the section only on the config tab", () => {
      expect(goalConsoleHref({ tab: "config", section: "tracker" })).toBe(
        "/goals?tab=config&section=tracker"
      )
      expect(goalConsoleHref({ tab: "analytics", section: "tracker" })).toBe("/goals?tab=analytics")
      expect(goalConsoleHref({ section: "tracker" })).toBe("/goals")
    })

    it("adds the selected goal, with or without a tab", () => {
      expect(goalConsoleHref({ goalId: "g1" })).toBe("/goals?goal=g1")
      expect(goalConsoleHref({ tab: "overview", goalId: "g 1" })).toBe(
        "/goals?tab=overview&goal=g+1"
      )
      expect(goalConsoleHref({ tab: "overview", goalId: null })).toBe("/goals?tab=overview")
    })
  })

  describe("DEFAULT_GOAL_CONSOLE_PREFS", () => {
    it("lands on the overview tab by default", () => {
      expect(DEFAULT_GOAL_CONSOLE_PREFS).toEqual({
        defaultTab: "overview",
        openGoalsSort: "created",
        openGoalsDir: "desc",
      })
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

    it("maps a stored retired defaultTab to config", () => {
      for (const retired of ["templates", "defaults", "tracker"]) {
        expect(resolveGoalConsolePrefs({ defaultTab: retired })).toEqual({
          ...DEFAULT_GOAL_CONSOLE_PREFS,
          defaultTab: "config",
        })
      }
    })

    it("merges a partial override over the defaults", () => {
      expect(resolveGoalConsolePrefs({ openGoalsDir: "asc" })).toEqual({
        ...DEFAULT_GOAL_CONSOLE_PREFS,
        openGoalsDir: "asc",
      })
    })

    it("ignores malformed enum values and falls back per-field", () => {
      const resolved = resolveGoalConsolePrefs({
        defaultTab: "bogus",
        openGoalsSort: "wat" as never,
        openGoalsDir: "sideways" as never,
      })
      expect(resolved).toEqual(DEFAULT_GOAL_CONSOLE_PREFS)
    })
  })
})
