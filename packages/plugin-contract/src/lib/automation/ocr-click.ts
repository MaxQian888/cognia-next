/**
 * The plugin contract's share of `lib/automation/ocr-click.ts`, which re-exports these.
 */
import type { Point } from "./action-schemas"

/** One OCR block resolved to physical screen coordinates. */
export interface ScreenTextMatch {
  text: string
  /** Screen-space bounding box (physical px). */
  bbox: { x: number; y: number; width: number; height: number }
  /** Center of the box — pass straight to `desktop.click`. */
  center: Point
  /** Provider confidence (0..1) when available. */
  confidence?: number
}

export interface FindScreenTextResult {
  ok: true
  providerId: string
  /** Matches ranked best-first when a `query` was given; all blocks otherwise. */
  matches: ScreenTextMatch[]
  /** Physical capture dimensions, for context. */
  capture: { width: number; height: number }
}
