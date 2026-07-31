// Pure logic for the automatic light/dark switcher (Settings → Appearance →
// Auto). Kept free of React/DOM so every branch is unit-testable: the runner
// hook (`hooks/appearance/use-auto-mode.ts`) is the only stateful consumer.
//
// `resolveAutoPhase` answers "which phase should be active right now?" for the
// three triggers:
//   - system   → follow the OS `prefers-color-scheme`.
//   - schedule → switch at user-set local `HH:mm` thresholds.
//   - sunset   → switch at local sunrise / sunset for a configured location
//                (NOAA "sunrise equation"); falls back to `system` when no
//                location is set or the sun never rises/sets that day.

import { DEFAULT_AUTOMODE } from "@/types/appearance"
import type { AutoModeLocation, AutoModeSettings } from "@/types/appearance"

export type AutoPhase = "light" | "dark"

/** Parse a 24h `"HH:mm"` string to minutes since local midnight, or null. */
export function parseHmToMinutes(hm: string | undefined): number | null {
  if (!hm) return null
  const match = /^([0-1]?\d|2[0-3]):([0-5]\d)$/.exec(hm.trim())
  if (!match) return null
  return Number(match[1]) * 60 + Number(match[2])
}

/** Local minutes since midnight for a Date. */
function minutesOfDay(d: Date): number {
  return d.getHours() * 60 + d.getMinutes()
}

/**
 * True while a recent manual mode change should suppress auto switching.
 * `snoozeMs <= 0` (or no recorded manual change) disables the snooze.
 */
export function isWithinSnooze(autoMode: AutoModeSettings, now: number): boolean {
  if (!autoMode.lastManualAt) return false
  const windowMs = autoMode.snoozeMs ?? DEFAULT_AUTOMODE.snoozeMs ?? 0
  if (windowMs <= 0) return false
  return now - autoMode.lastManualAt < windowMs
}

const DEG = Math.PI / 180

/**
 * Local sunrise / sunset (minutes since local midnight) for a location and
 * date, via the NOAA "sunrise equation". Returns null on polar day/night
 * (the sun stays up or down all day), letting callers fall back to `system`.
 */
export function computeSunTimesMinutes(
  loc: AutoModeLocation,
  date: Date
): { sunriseMin: number; sunsetMin: number } | null {
  const { latitude: lat, longitude: lng } = loc
  // Julian day number for the date's UTC calendar day.
  const jdNow = date.getTime() / 86_400_000 + 2_440_587.5
  const n = Math.round(jdNow - 2_451_545.0 + 0.0008)
  // Mean solar time (longitude west positive in the equation).
  const lw = -lng
  const jStar = n - lw / 360
  const M = (357.5291 + 0.98560028 * jStar) % 360
  const Mrad = M * DEG
  const C = 1.9148 * Math.sin(Mrad) + 0.02 * Math.sin(2 * Mrad) + 0.0003 * Math.sin(3 * Mrad)
  const lambda = ((M + C + 180 + 102.9372) % 360) * DEG
  const jTransit = 2_451_545.0 + jStar + 0.0053 * Math.sin(Mrad) - 0.0069 * Math.sin(2 * lambda)
  const sinDecl = Math.sin(lambda) * Math.sin(23.4397 * DEG)
  const cosDecl = Math.cos(Math.asin(sinDecl))
  const cosOmega =
    (Math.sin(-0.833 * DEG) - Math.sin(lat * DEG) * sinDecl) / (Math.cos(lat * DEG) * cosDecl)
  if (cosOmega > 1 || cosOmega < -1) return null // polar night / midnight sun
  const omega = Math.acos(cosOmega) / DEG
  const jSet = jTransit + omega / 360
  const jRise = jTransit - omega / 360
  const riseDate = new Date((jRise - 2_440_587.5) * 86_400_000)
  const setDate = new Date((jSet - 2_440_587.5) * 86_400_000)
  return { sunriseMin: minutesOfDay(riseDate), sunsetMin: minutesOfDay(setDate) }
}

export interface ResolveContext {
  now: Date
  systemPrefersDark: boolean
}

/** The phase auto-mode should currently enforce for the given settings. */
export function resolveAutoPhase(autoMode: AutoModeSettings, ctx: ResolveContext): AutoPhase {
  const systemPhase: AutoPhase = ctx.systemPrefersDark ? "dark" : "light"
  switch (autoMode.trigger) {
    case "system":
      return systemPhase
    case "schedule": {
      const lightAt = parseHmToMinutes(autoMode.schedule?.lightAt)
      const darkAt = parseHmToMinutes(autoMode.schedule?.darkAt)
      if (lightAt == null || darkAt == null || lightAt === darkAt) return systemPhase
      const m = minutesOfDay(ctx.now)
      // Light phase spans [lightAt, darkAt); wraps past midnight when lightAt > darkAt.
      const inLight = lightAt < darkAt ? m >= lightAt && m < darkAt : m >= lightAt || m < darkAt
      return inLight ? "light" : "dark"
    }
    case "sunset": {
      if (!autoMode.location) return systemPhase
      const sun = computeSunTimesMinutes(autoMode.location, ctx.now)
      if (!sun) return systemPhase
      const m = minutesOfDay(ctx.now)
      return m >= sun.sunriseMin && m < sun.sunsetMin ? "light" : "dark"
    }
    default:
      return systemPhase
  }
}
