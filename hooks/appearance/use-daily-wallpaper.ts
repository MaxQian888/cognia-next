"use client"

/**
 * The daily-wallpaper scheduler.
 *
 * Called from `BackgroundApplier`, alongside `useWallpaperRotation`, for the
 * same reason: one mount point for the whole background subsystem, so there is
 * one place to look and one thing to forget to wire rather than three.
 *
 * What this owns is the decision to RUN a fetch, never the fetch itself. The
 * fetch, its gates and its failure codes live in `fetch-daily-wallpaper.ts` and
 * are pure enough to test without a network.
 *
 * The one rule worth stating out loud: a failure is recorded, not swallowed.
 * `lastError` is persisted so the settings card can say what happened, because
 * a daily wallpaper that silently stopped updating looks exactly like one that
 * was never switched on.
 */

import { useCallback, useEffect, useRef } from "react"
import { useLocale } from "next-intl"

import { useSettingsStore } from "@/stores/settings"
import { deleteImage } from "@/lib/appearance/wallpaper-storage"
import {
  fetchDailyWallpaper,
  selectExpiredDailyWallpapers,
} from "@/lib/appearance/daily-wallpaper/fetch-daily-wallpaper"
import { isLikelyMeteredConnection, isOnline } from "@/lib/appearance/daily-wallpaper/network-cost"
import type { Wallpaper } from "@/types/appearance"
import {
  clampKeepCount,
  clampRefreshHours,
  DEFAULT_DAILY_WALLPAPER,
  type DailyWallpaperSettings,
} from "@/types/appearance/daily-wallpaper"

/** See the note on the rotation hook: setTimeout overflows past ~24.8 days. */
const MAX_TIMEOUT_MS = 60 * 60 * 1000

/**
 * Grace period after a failure before trying again.
 *
 * Without it, a provider that is down turns the refresh cadence into a retry
 * loop at whatever rate the effect happens to re-run. Fifteen minutes is long
 * enough to be polite to the endpoint and short enough that a transient outage
 * resolves itself without the user touching anything.
 */
export const FAILURE_BACKOFF_MS = 15 * 60 * 1000

export function useDailyWallpaper(): void {
  const locale = useLocale()
  const background = useSettingsStore((s) => s.background)
  const setBackground = useSettingsStore((s) => s.setBackground)
  const addWallpaper = useSettingsStore((s) => s.addWallpaper)
  const deleteWallpaper = useSettingsStore((s) => s.deleteWallpaper)

  const daily: DailyWallpaperSettings = {
    ...DEFAULT_DAILY_WALLPAPER,
    ...(background.daily ?? {}),
  }
  const { enabled, providerId, refreshHours, wifiOnly, lastFetchedAt } = daily

  const timerRef = useRef<number | null>(null)
  // Guards against a second run starting while the first is still downloading.
  // The effect re-runs on every settings change, and a slow fetch would
  // otherwise overlap with the one the write it makes triggers.
  const inFlightRef = useRef(false)

  const runFetch = useCallback(async () => {
    if (inFlightRef.current) return
    inFlightRef.current = true
    try {
      await runDailyWallpaperFetch({ locale, setBackground, addWallpaper, deleteWallpaper })
    } finally {
      inFlightRef.current = false
    }
  }, [locale, setBackground, addWallpaper, deleteWallpaper])

  useEffect(() => {
    if (typeof window === "undefined") return
    if (!enabled) return

    let disposed = false

    const clear = () => {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current)
        timerRef.current = null
      }
    }

    const evaluate = () => {
      if (disposed) return
      clear()

      const live: DailyWallpaperSettings = {
        ...DEFAULT_DAILY_WALLPAPER,
        ...(useSettingsStore.getState().background.daily ?? {}),
      }
      const delay = msUntilNextFetch(live, Date.now())

      if (delay > 0) {
        timerRef.current = window.setTimeout(evaluate, Math.min(delay, MAX_TIMEOUT_MS))
        return
      }

      // Offline, or on a connection the user asked us to respect. Re-arm on a
      // short timer rather than dropping the schedule, so coming back onto
      // wifi does not require a restart.
      if (!isOnline() || (live.wifiOnly && isLikelyMeteredConnection())) {
        timerRef.current = window.setTimeout(evaluate, FAILURE_BACKOFF_MS)
        return
      }

      void runFetch()
    }

    evaluate()

    const onOnline = () => evaluate()
    window.addEventListener("online", onOnline)
    return () => {
      disposed = true
      clear()
      window.removeEventListener("online", onOnline)
    }
  }, [enabled, providerId, refreshHours, wifiOnly, lastFetchedAt, daily.lastError?.at, runFetch])
}

/**
 * Milliseconds until the next fetch is owed.
 *
 * Exported for tests. A never-fetched source is due immediately, which is what
 * makes switching the feature on produce a wallpaper rather than a wait.
 * A recent FAILURE holds the schedule for {@link FAILURE_BACKOFF_MS} instead of
 * the full period, so a transient outage recovers without waiting a day.
 */
export function msUntilNextFetch(settings: DailyWallpaperSettings, now: number): number {
  const periodMs = clampRefreshHours(settings.refreshHours) * 60 * 60 * 1000

  if (settings.lastError) {
    const since = now - settings.lastError.at
    // A future timestamp means the clock moved. Retry rather than wedge.
    if (since >= 0 && since < FAILURE_BACKOFF_MS) return FAILURE_BACKOFF_MS - since
  }

  if (settings.lastFetchedAt === undefined) return 0
  const elapsed = now - settings.lastFetchedAt
  if (elapsed < 0) return 0
  return Math.max(0, periodMs - elapsed)
}

export interface RunDailyFetchDeps {
  locale: string
  setBackground: (patch: {
    activeId?: string
    enabled?: boolean
    daily: DailyWallpaperSettings
  }) => Promise<void>
  addWallpaper: (wallpaper: Wallpaper) => Promise<void>
  deleteWallpaper: (id: string) => Promise<void>
  /** Injectable for tests and for the manual "fetch now" button. */
  fetch?: typeof fetchDailyWallpaper
}

/**
 * One fetch, plus everything that has to happen around it: persist the result,
 * apply it if asked, record a failure if there was one, and reap whatever
 * retention says is expired.
 *
 * Extracted from the hook so the settings card's "Fetch now" button runs the
 * SAME code the timer does. A separate manual path is how the two drift, and
 * "it works when I click it but not on its own" is the bug that follows.
 */
export async function runDailyWallpaperFetch(deps: RunDailyFetchDeps): Promise<void> {
  const { locale, setBackground, addWallpaper, deleteWallpaper } = deps
  const state = useSettingsStore.getState()
  const live: DailyWallpaperSettings = {
    ...DEFAULT_DAILY_WALLPAPER,
    ...(state.background.daily ?? {}),
  }
  if (!live.enabled) return

  const result = await (deps.fetch ?? fetchDailyWallpaper)({ settings: live, locale })

  if (!result.ok) {
    await setBackground({
      daily: { ...live, lastError: { code: result.code, at: Date.now(), status: result.status } },
    })
    return
  }

  if ("skipped" in result) {
    // Nothing new. Still stamp the clock, so the next check is a period away
    // rather than immediate.
    await setBackground({
      daily: {
        ...live,
        lastFetchedAt: Date.now(),
        lastEntryKey: result.entryKey,
        lastError: undefined,
      },
    })
    return
  }

  await addWallpaper(result.wallpaper)

  const nextDaily: DailyWallpaperSettings = {
    ...live,
    lastFetchedAt: Date.now(),
    lastEntryKey: result.candidate.entryKey,
    lastError: undefined,
  }
  await setBackground(
    live.autoApply
      ? { activeId: result.wallpaper.id, enabled: true, daily: nextDaily }
      : { daily: nextDaily }
  )

  // Retention runs last and reads the store fresh, so it sees the wallpaper
  // just added and the activeId just written.
  const after = useSettingsStore.getState()
  const expired = selectExpiredDailyWallpapers(
    after.wallpapers,
    clampKeepCount(live.keepCount),
    after.background.activeId
  )
  for (const wallpaper of expired) {
    // Bytes first, then the row. The reverse order would leave a row pointing
    // at nothing whenever the byte deletion failed.
    await deleteImage(wallpaper.source).catch(() => {})
    await deleteWallpaper(wallpaper.id)
  }
}
