import {
  hasProjectPrefs,
  resolvePreferences,
  resolveProjectPref,
  resolveSourcePref,
} from "./preferences"
import { DEFAULT_NOTIFICATION_PREFERENCES } from "@/types/notifications"

describe("resolvePreferences", () => {
  it("returns the defaults when nothing is stored", () => {
    expect(resolvePreferences()).toBe(DEFAULT_NOTIFICATION_PREFERENCES)
    expect(resolvePreferences(null)).toBe(DEFAULT_NOTIFICATION_PREFERENCES)
  })

  it("merges a shallow partial over the defaults", () => {
    const merged = resolvePreferences({ minOsLevel: "error", sound: false })
    expect(merged.minOsLevel).toBe("error")
    expect(merged.sound).toBe(false)
    expect(merged.minPushLevel).toBe(DEFAULT_NOTIFICATION_PREFERENCES.minPushLevel)
  })

  it("deep-merges quietHours and isolates perSource", () => {
    const merged = resolvePreferences({ quietHours: { enabled: true } as never })
    expect(merged.quietHours).toEqual({ enabled: true, start: "22:00", end: "08:00" })
    const stored = { perSource: { plugin: { enabled: false } } }
    const out = resolvePreferences(stored as never)
    expect(out.perSource.plugin).toEqual({ enabled: false })
    expect(out.perSource).not.toBe(stored.perSource)
  })

  it("keeps an explicit empty channel list", () => {
    expect(resolvePreferences({ globalDefaultChannels: [] }).globalDefaultChannels).toEqual([])
  })
})

describe("resolveSourcePref", () => {
  it("defaults to enabled with no overrides", () => {
    expect(resolveSourcePref(DEFAULT_NOTIFICATION_PREFERENCES, "scheduler")).toEqual({
      enabled: true,
    })
  })

  it("returns the stored override when present", () => {
    const prefs = resolvePreferences({ perSource: { plugin: { enabled: false } } } as never)
    expect(resolveSourcePref(prefs, "plugin")).toEqual({ enabled: false })
  })
})

describe("per-workspace preferences", () => {
  it("carries stored workspace overrides and answers lookups", () => {
    const prefs = resolvePreferences({ perProject: { w1: { enabled: false } } })
    expect(resolveProjectPref(prefs, "w1")).toEqual({ enabled: false })
    expect(resolveProjectPref(prefs, "w2")).toBeUndefined()
    expect(resolveProjectPref(prefs, undefined)).toBeUndefined()
    expect(hasProjectPrefs(prefs)).toBe(true)
    expect(hasProjectPrefs(resolvePreferences(null))).toBe(false)
    expect(hasProjectPrefs(resolvePreferences({}))).toBe(false)
  })
})
