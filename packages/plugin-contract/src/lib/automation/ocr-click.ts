/**
 * The plugin contract's share of `lib/automation/ocr-click.ts`, which re-exports these.
 */
import type { Point } from "./action-schemas"

/** Copy from the most recent get_app_state. No caller-supplied image is trusted. */
export interface AppOcrState {
  sessionId: string
  lineageId: string
  revision: number
  turnToken: string
  surface: { pixelWidth: number; pixelHeight: number }
}

/** One OCR block resolved to physical screen coordinates. */
export interface ScreenTextMatch {
  text: string
  /** Screen-space bounding box (physical px). */
  bbox: { x: number; y: number; width: number; height: number }
  /** Center of the box — pass straight to `desktop.click`. */
  center: Point
  /** Host-frame-derived desktop coordinate for permission policy, when app-bound. */
  desktopCenter?: Point
  /** Provider confidence (0..1) when available. */
  confidence?: number
}

export interface FindScreenTextResult {
  ok: true
  providerId: string
  /** Matches ranked best-first when a `query` was given; all blocks otherwise. */
  matches: ScreenTextMatch[]
  /** Physical capture dimensions, for context. */
  capture: { width: number; height: number; coordinateSpace?: "screenshotPixels" | "desktop" }
}
