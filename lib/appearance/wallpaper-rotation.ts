/**
 * Rotation scheduling, as pure functions.
 *
 * Everything that decides WHICH wallpaper is next and WHEN lives here, with no
 * timers, no DOM and no store access, so the interesting cases (an empty
 * playlist, a deleted wallpaper, a clock that jumped backwards, a machine that
 * slept through three intervals) are ordinary unit tests rather than something
 * you have to sit and watch for fifteen minutes.
 *
 * The runtime half is `use-wallpaper-rotation.ts`, which owns the timer and the
 * one Dexie write per advance.
 */

import type { Wallpaper } from "@/types/appearance"
import {
  clampRotationInterval,
  type WallpaperRotationOrder,
  type WallpaperRotationSettings,
} from "@/types/appearance/wallpaper-rotation"

/**
 * Wallpapers eligible for rotation when the playlist is empty.
 *
 * Solid colours are excluded. A carousel that flips between a photograph and a
 * flat `#1e293b` reads as a rendering bug rather than a feature, and a user who
 * genuinely wants that can still put the colour in an explicit playlist.
 */
export function isRotatable(wallpaper: Wallpaper): boolean {
  return wallpaper.kind === "image" || wallpaper.kind === "gradient"
}

/**
 * Resolve the ordered set of wallpaper ids the rotation will actually cycle.
 *
 * An explicit playlist is honoured in ITS order, filtered to ids that still
 * exist. That filtering is the whole reason this is a function: a playlist is
 * a list of ids, wallpapers get deleted, and advancing onto a dead id would
 * blank the background with no way for the user to tell why.
 *
 * An empty playlist means "everything rotatable", in gallery order.
 */
export function resolveRotationPool(
  playlist: readonly string[],
  gallery: readonly Wallpaper[]
): string[] {
  if (playlist.length === 0) {
    return gallery.filter(isRotatable).map((w) => w.id)
  }
  const byId = new Map(gallery.map((w) => [w.id, w]))
  const seen = new Set<string>()
  const resolved: string[] = []
  for (const id of playlist) {
    if (seen.has(id)) continue
    if (!byId.has(id)) continue
    seen.add(id)
    resolved.push(id)
  }
  return resolved
}

export interface PickNextArgs {
  pool: readonly string[]
  currentId: string | null
  order: WallpaperRotationOrder
  /** Injectable for deterministic tests. Defaults to `Math.random`. */
  random?: () => number
}

/**
 * Choose the next wallpaper id.
 *
 * Returns `null` when there is nothing to advance to, which is a real state and
 * not an error: an empty gallery, or a pool of exactly the wallpaper already
 * showing. Callers treat `null` as "leave the background alone" rather than
 * "clear it".
 *
 * `shuffle` never returns the current wallpaper while the pool has an
 * alternative. Without that guard a two-item shuffle spends half its advances
 * appearing to do nothing, which users read as a broken timer.
 */
export function pickNextWallpaperId(args: PickNextArgs): string | null {
  const { pool, currentId, order } = args
  if (pool.length === 0) return null
  if (pool.length === 1) return pool[0] === currentId ? null : pool[0]

  if (order === "sequential") {
    const idx = currentId === null ? -1 : pool.indexOf(currentId)
    // A current wallpaper outside the pool restarts the cycle at the top
    // rather than being treated as index -1 + 1 === 0 by accident.
    const nextIdx = idx < 0 ? 0 : (idx + 1) % pool.length
    return pool[nextIdx]
  }

  const random = args.random ?? Math.random
  const candidates = currentId === null ? pool : pool.filter((id) => id !== currentId)
  if (candidates.length === 0) return null
  const roll = random()
  // Guard against a stubbed random returning exactly 1 (or anything out of
  // range), which would index past the end.
  const bounded = Number.isFinite(roll) ? Math.min(Math.max(roll, 0), 0.999_999_999) : 0
  return candidates[Math.floor(bounded * candidates.length)]
}

/** Local-calendar day key, so `daily` lands on midnight rather than on +24h. */
export function localDayKey(epochMs: number): string {
  const d = new Date(epochMs)
  const month = `${d.getMonth() + 1}`.padStart(2, "0")
  const day = `${d.getDate()}`.padStart(2, "0")
  return `${d.getFullYear()}-${month}-${day}`
}

export interface AdvanceDueArgs {
  rotation: WallpaperRotationSettings
  now: number
  /**
   * Whether this evaluation is the first since the app started. Only the
   * `launch` trigger cares, and it is passed in rather than tracked here so
   * this stays a pure function.
   */
  isFirstEvaluation?: boolean
}

/**
 * Whether an advance is owed right now.
 *
 * The three triggers fail in different ways and are handled separately:
 *
 *   - `interval` compares elapsed wall-clock time. A `lastAdvancedAt` in the
 *     FUTURE (clock moved backwards, or a settings row restored from a backup
 *     taken on another machine) would otherwise wedge the rotation until real
 *     time caught up, so it is treated as due immediately.
 *   - `daily` compares local calendar days, so a laptop closed at 23:00 and
 *     opened at 08:00 gets its new wallpaper even though only nine hours
 *     passed. It also handles a multi-day gap as ONE advance, not one per day.
 *   - `launch` is due exactly once per process.
 *
 * A rotation that has never advanced is NOT due on first evaluation for the
 * timed triggers. Enabling a carousel should not yank the wallpaper the user
 * just chose out from under them.
 */
export function isAdvanceDue(args: AdvanceDueArgs): boolean {
  const { rotation, now } = args
  if (!rotation.enabled) return false

  if (rotation.trigger === "launch") {
    return args.isFirstEvaluation === true
  }

  const last = rotation.lastAdvancedAt
  if (last === undefined) return false

  if (rotation.trigger === "daily") {
    return localDayKey(last) !== localDayKey(now)
  }

  if (last > now) return true
  return now - last >= clampRotationInterval(rotation.intervalMs)
}

/**
 * Milliseconds until the next advance, for scheduling a timer.
 *
 * Returns `null` when nothing is scheduled (`launch`, or a rotation that has
 * not advanced yet under a timed trigger and therefore starts its first
 * interval from now). Callers that get `null` for a timed trigger should stamp
 * `lastAdvancedAt` so the clock starts.
 */
export function msUntilNextAdvance(
  rotation: WallpaperRotationSettings,
  now: number
): number | null {
  if (!rotation.enabled) return null
  if (rotation.trigger === "launch") return null

  const last = rotation.lastAdvancedAt
  if (last === undefined) return null

  if (rotation.trigger === "daily") {
    const midnight = new Date(now)
    midnight.setHours(24, 0, 0, 0)
    return Math.max(0, midnight.getTime() - now)
  }

  if (last > now) return 0
  return Math.max(0, clampRotationInterval(rotation.intervalMs) - (now - last))
}
