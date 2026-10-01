"use client"

/**
 * The legibility guard's runtime half.
 *
 * Called from `BackgroundApplier` — the one mount point the wallpaper subsystem
 * has — like the rotation and daily-wallpaper hooks. All the deciding lives in
 * `lib/appearance/wallpaper-legibility.ts`; this hook only gathers its inputs
 * (the wallpaper's analysis, the theme's live colours) and writes the answer to
 * `--wp-max-weight` on `<body>`, which globals.css folds into the wallpaper
 * layer's opacity with `min()`.
 *
 * Nothing here is React state. The output is a custom property on `<body>`, so
 * every input change goes straight from an effect or observer to the DOM
 * without a render in between.
 */

import { useEffect, useMemo } from "react"

import {
  analysisCacheKey,
  readCachedAnalysis,
  writeCachedAnalysis,
} from "@/lib/appearance/wallpaper-analysis-cache"
import {
  WP_MAX_WEIGHT_VAR,
  extremesOf,
  formatMaxWeight,
  solveMaxImageWeight,
} from "@/lib/appearance/wallpaper-legibility"
import { readThemeInk } from "@/lib/appearance/wallpaper-readability"
import {
  analyzeWallpaperSource,
  type WallpaperThemeAnalysis,
} from "@/lib/appearance/wallpaper-theme-generator"
import { getPetWindowRole, isSecondaryOverlayRole } from "@/lib/pet/window-role"
import type { Wallpaper } from "@/types/appearance"

export interface UseWallpaperLegibilityArgs {
  /** The wallpaper being painted, or null when the layer is off. */
  wallpaper: Wallpaper | null
  /** The layer's own blur, in px. */
  blurPx: number
  /** Whether the guard is on (`isLegibilityGuardOn`). */
  guard: boolean
  /**
   * The `url(...)` value currently painted for an image wallpaper. Analysing it
   * reuses bytes already in memory; resolving the source again would re-read a
   * disk wallpaper over IPC.
   */
  paintedCss: string | null
}

function clearMaxWeight(): void {
  document.body?.style.removeProperty(WP_MAX_WEIGHT_VAR)
}

function writeMaxWeight(analysis: WallpaperThemeAnalysis | null, blurPx: number): void {
  const ink = readThemeInk()
  // No readable theme colours: leave the layer uncapped rather than guess.
  if (!ink) {
    clearMaxWeight()
    return
  }
  const weight = formatMaxWeight(
    solveMaxImageWeight({ ink, extremes: extremesOf(analysis), blurPx })
  )
  if (weight === null) clearMaxWeight()
  else document.body.style.setProperty(WP_MAX_WEIGHT_VAR, weight)
}

/**
 * The resolved colours the solve depends on — text, ground and the translucent
 * surfaces with their tonality — as one comparable string.
 */
function inkSignature(): string {
  const ink = readThemeInk()
  return ink ? JSON.stringify(ink) : ""
}

export function useWallpaperLegibility({
  wallpaper,
  blurPx,
  guard,
  paintedCss,
}: UseWallpaperLegibilityArgs): void {
  const key = useMemo(() => (wallpaper ? analysisCacheKey(wallpaper) : null), [wallpaper])
  const source = wallpaper?.source ?? null
  // Only images need the painted bytes; a gradient or colour is analysed from
  // its declaration, so a stale `paintedCss` must not re-run its effect.
  const imageCss = source?.kind === "image" ? paintedCss : null

  useEffect(() => {
    if (typeof document === "undefined" || !document.body) return
    // Paint-through pet / island windows force the wallpaper off; there is
    // nothing to guard and no reason to decode an image there.
    if (isSecondaryOverlayRole(getPetWindowRole())) {
      clearMaxWeight()
      return
    }
    if (!key || !source) {
      clearMaxWeight()
      return
    }
    // The analysis is wanted even with the guard off: wallpaper-driven auto
    // light/dark and the panel's theme-fit hint read it from the cache. Only
    // the cap itself belongs to the guard.
    if (!guard) clearMaxWeight()

    let cancelled = false
    // `undefined` = not known yet; `null` = analysis failed (solve blind).
    let analysis: WallpaperThemeAnalysis | null | undefined = readCachedAnalysis(key) ?? undefined
    let signature = ""
    // A cap solved for the previous wallpaper says nothing about this one; do
    // not let it dim (or under-dim) the new image while its analysis runs.
    if (guard && analysis === undefined) clearMaxWeight()

    const solve = () => {
      if (cancelled || analysis === undefined || !guard) return
      signature = inkSignature()
      writeMaxWeight(analysis, blurPx)
    }

    if (analysis !== undefined) {
      solve()
    } else if (source.kind !== "image" || imageCss) {
      analyzeWallpaperSource(source, imageCss ? { paintedCss: imageCss } : {})
        .then((next) => {
          writeCachedAnalysis(key, next)
          analysis = next
        })
        .catch(() => {
          analysis = null
        })
        .finally(solve)
    }
    // An image whose painted value has not arrived yet: the applier hands it
    // over on the next render, which re-runs this effect.

    if (!guard) {
      return () => {
        cancelled = true
      }
    }

    // Theme changes arrive as class / inline-style writes on <html> (next-themes,
    // the custom-theme and style-pack appliers) or as a <style> element in
    // <head> (plugin themes). Most of those writes do not move the three
    // colours the solve reads, so coalesce to one check per frame and re-solve
    // only when the resolved colours actually changed.
    let frame: number | null = null
    const check = () => {
      frame = null
      if (analysis === undefined || inkSignature() === signature) return
      solve()
    }
    const schedule = () => {
      if (frame !== null) return
      frame = requestAnimationFrame(check)
    }
    const observer = new MutationObserver(schedule)
    observer.observe(document.documentElement, { attributes: true })
    observer.observe(document.head, { childList: true, subtree: true, characterData: true })

    return () => {
      cancelled = true
      observer.disconnect()
      if (frame !== null) cancelAnimationFrame(frame)
    }
  }, [key, source, imageCss, blurPx, guard])

  // Leaving the app shell must not strand a cap on the next mount's wallpaper.
  useEffect(() => clearMaxWeight, [])
}
