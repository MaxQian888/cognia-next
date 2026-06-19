import {
  computeSunTimesMinutes,
  isWithinSnooze,
  parseHmToMinutes,
  resolveAutoPhase,
} from "./auto-mode"
import { DEFAULT_AUTOMODE } from "@/types/appearance"
import type { AutoModeSettings } from "@/types/appearance"

function automode(patch: Partial<AutoModeSettings>): AutoModeSettings {
  return { ...DEFAULT_AUTOMODE, ...patch }
}

describe("parseHmToMinutes", () => {
  it("parses valid 24h times", () => {
    expect(parseHmToMinutes("00:00")).toBe(0)
    expect(parseHmToMinutes("6:30")).toBe(390)
    expect(parseHmToMinutes("23:59")).toBe(1439)
  })
  it("rejects malformed input", () => {
    expect(parseHmToMinutes(undefined)).toBeNull()
    expect(parseHmToMinutes("")).toBeNull()
    expect(parseHmToMinutes("24:00")).toBeNull()
    expect(parseHmToMinutes("12:60")).toBeNull()
    expect(parseHmToMinutes("noon")).toBeNull()
  })
})

describe("isWithinSnooze", () => {
  const now = 1_000_000_000
  it("is false without a recorded manual change", () => {
    expect(isWithinSnooze(automode({}), now)).toBe(false)
  })
  it("is true inside and false outside the snooze window", () => {
    const snoozeMs = 30 * 60 * 1000
    expect(isWithinSnooze(automode({ lastManualAt: now - 1000, snoozeMs }), now)).toBe(true)
    expect(isWithinSnooze(automode({ lastManualAt: now - snoozeMs - 1, snoozeMs }), now)).toBe(
      false
    )
  })
  it("treats a non-positive window as disabled", () => {
    expect(isWithinSnooze(automode({ lastManualAt: now, snoozeMs: 0 }), now)).toBe(false)
  })
})

describe("resolveAutoPhase — system", () => {
  it("follows the OS preference", () => {
    const am = automode({ trigger: "system" })
    expect(resolveAutoPhase(am, { now: new Date(), systemPrefersDark: true })).toBe("dark")
    expect(resolveAutoPhase(am, { now: new Date(), systemPrefersDark: false })).toBe("light")
  })
})

describe("resolveAutoPhase — schedule", () => {
  const am = automode({ trigger: "schedule", schedule: { lightAt: "07:00", darkAt: "19:00" } })
  it("is light during the day window and dark outside it", () => {
    const at = (h: number, m = 0) => new Date(2024, 0, 1, h, m)
    expect(resolveAutoPhase(am, { now: at(12), systemPrefersDark: false })).toBe("light")
    expect(resolveAutoPhase(am, { now: at(7), systemPrefersDark: false })).toBe("light")
    expect(resolveAutoPhase(am, { now: at(19), systemPrefersDark: false })).toBe("dark")
    expect(resolveAutoPhase(am, { now: at(2), systemPrefersDark: false })).toBe("dark")
  })
  it("handles an overnight light window (lightAt > darkAt)", () => {
    const night = automode({ trigger: "schedule", schedule: { lightAt: "20:00", darkAt: "06:00" } })
    const at = (h: number) => new Date(2024, 0, 1, h, 0)
    expect(resolveAutoPhase(night, { now: at(23), systemPrefersDark: false })).toBe("light")
    expect(resolveAutoPhase(night, { now: at(3), systemPrefersDark: false })).toBe("light")
    expect(resolveAutoPhase(night, { now: at(12), systemPrefersDark: false })).toBe("dark")
  })
  it("falls back to the system phase when the schedule is incomplete or degenerate", () => {
    const noSchedule = automode({ trigger: "schedule" })
    expect(resolveAutoPhase(noSchedule, { now: new Date(), systemPrefersDark: true })).toBe("dark")
    const same = automode({ trigger: "schedule", schedule: { lightAt: "08:00", darkAt: "08:00" } })
    expect(resolveAutoPhase(same, { now: new Date(), systemPrefersDark: false })).toBe("light")
  })
})

describe("computeSunTimesMinutes", () => {
  it("returns plausible in-range times for a temperate location", () => {
    const sun = computeSunTimesMinutes(
      { latitude: 40, longitude: -74, source: "manual" },
      new Date(2024, 2, 20, 12, 0)
    )
    expect(sun).not.toBeNull()
    expect(sun!.sunriseMin).toBeGreaterThanOrEqual(0)
    expect(sun!.sunriseMin).toBeLessThan(1440)
    expect(sun!.sunsetMin).toBeGreaterThanOrEqual(0)
    expect(sun!.sunsetMin).toBeLessThan(1440)
  })
  it("returns null during polar night / midnight sun", () => {
    const polar = computeSunTimesMinutes(
      { latitude: 85, longitude: 0, source: "manual" },
      new Date(2024, 11, 21, 12, 0)
    )
    expect(polar).toBeNull()
  })
})

describe("resolveAutoPhase — sunset", () => {
  it("falls back to system without a location", () => {
    const am = automode({ trigger: "sunset" })
    expect(resolveAutoPhase(am, { now: new Date(), systemPrefersDark: true })).toBe("dark")
  })
  it("falls back to system for a polar location with no sunrise/sunset", () => {
    const am = automode({
      trigger: "sunset",
      location: { latitude: 85, longitude: 0, source: "manual" },
    })
    expect(
      resolveAutoPhase(am, { now: new Date(2024, 11, 21, 12), systemPrefersDark: false })
    ).toBe("light")
  })
  it("returns a valid phase for a temperate location", () => {
    const am = automode({
      trigger: "sunset",
      location: { latitude: 40, longitude: -74, source: "manual" },
    })
    const phase = resolveAutoPhase(am, { now: new Date(2024, 5, 21, 12), systemPrefersDark: false })
    expect(["light", "dark"]).toContain(phase)
  })
})
