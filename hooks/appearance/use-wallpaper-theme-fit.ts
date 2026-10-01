"use client"

/**
 * Which light/dark variant a wallpaper suits, for the settings UI.
 *
 * Reads the analysis the legibility guard caches (the guard measures the active
 * wallpaper whether or not it is capping) and re-renders when a new one lands,
 * so the wallpaper panel's "better in dark" hint and the auto light/dark tab's
 * status line appear as soon as the image is measured. The deciding lives in
 * `recommendThemeVariant`; this hook only subscribes.
 */

import { useMemo, useSyncExternalStore } from "react"

import {
  readCachedAnalysisFor,
  subscribeAnalysisCache,
} from "@/lib/appearance/wallpaper-analysis-cache"
import {
  extremesOf,
  recommendThemeVariant,
  type ThemeFit,
} from "@/lib/appearance/wallpaper-legibility"
import type { WallpaperThemeAnalysis } from "@/lib/appearance/wallpaper-theme-generator"
import type { Wallpaper } from "@/types/appearance"

export interface WallpaperThemeFitState {
  /** Null while there is no wallpaper, or it has not been measured yet. */
  fit: ThemeFit | null
  /** True once an analysis exists for this wallpaper. */
  measured: boolean
}

const serverSnapshot = () => null

export function useWallpaperThemeFit(
  wallpaper: Pick<Wallpaper, "id" | "source"> | null,
  blurPx: number,
  /**
   * An analysis the caller already holds (the panel's own sampler). Used until
   * the cache has one, so the hint does not wait on the guard for a wallpaper
   * the panel measured first.
   */
  fallback?: WallpaperThemeAnalysis | null
): WallpaperThemeFitState {
  // The cache hands back the same object for a key until it is rewritten, so
  // this snapshot is referentially stable between writes.
  const cached = useSyncExternalStore(
    subscribeAnalysisCache,
    () => readCachedAnalysisFor(wallpaper),
    serverSnapshot
  )
  const analysis = cached ?? fallback ?? null
  const fit = useMemo(
    () =>
      wallpaper && analysis
        ? recommendThemeVariant({ extremes: extremesOf(analysis), blurPx })
        : null,
    [wallpaper, analysis, blurPx]
  )
  return { fit, measured: analysis !== null }
}
