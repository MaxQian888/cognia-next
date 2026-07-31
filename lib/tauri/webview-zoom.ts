"use client"

import { isTauri } from "@/lib/tauri"
import { loggers } from "@cognia/logging"

const log = loggers.ui

/** Minimum zoom factor (50%). */
export const MIN_ZOOM = 0.5
/** Maximum zoom factor (200%). */
export const MAX_ZOOM = 2.0
/** Step size for zoom in / zoom out. */
export const ZOOM_STEP = 0.1
/** Default / "reset" zoom factor. */
export const DEFAULT_ZOOM = 1.0

/** Clamp a zoom level to the legal range, rounded to one decimal place. */
export function clampZoom(level: number): number {
  if (!Number.isFinite(level)) return DEFAULT_ZOOM
  const clamped = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, level))
  // Round to 0.05 to avoid float drift from successive +0.1 / -0.1 ops.
  return Math.round(clamped * 20) / 20
}

/**
 * Apply a zoom level. Tauri path uses the webview's `setZoom`; web path
 * falls back to CSS `zoom` on `<html>` so dev builds in the browser still
 * show the change.
 */
export async function applyZoom(level: number): Promise<number> {
  const next = clampZoom(level)
  if (isTauri()) {
    try {
      const { getCurrentWebview } = await import("@tauri-apps/api/webview")
      await getCurrentWebview().setZoom(next)
      return next
    } catch (err) {
      log.error("webview-zoom setZoom failed", err)
      return next
    }
  }
  if (typeof document !== "undefined") {
    // CSS `zoom` is supported on Chromium-based webviews used by Tauri's
    // dev preview and the Chrome/Edge browsers most users dev in.
    document.documentElement.style.zoom = String(next)
  }
  return next
}

/** Increase zoom by one step, returning the new applied level. */
export function zoomIn(current: number): Promise<number> {
  return applyZoom(current + ZOOM_STEP)
}

/** Decrease zoom by one step, returning the new applied level. */
export function zoomOut(current: number): Promise<number> {
  return applyZoom(current - ZOOM_STEP)
}

/** Reset zoom to {@link DEFAULT_ZOOM}, returning the new applied level. */
export function resetZoom(): Promise<number> {
  return applyZoom(DEFAULT_ZOOM)
}

/** Format a zoom level as a human-readable percentage string ("100%"). */
export function formatZoomPercent(level: number): string {
  return `${Math.round(clampZoom(level) * 100)}%`
}
