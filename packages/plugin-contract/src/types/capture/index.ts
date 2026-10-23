/**
 * Content Capture — an OpenWiki-style "confirm bubble" flow: copy/hotkey → a
 * confirm bubble with a countdown → save + async enrichment (URL reader / OCR)
 * + source-app tag. Captured items feed the Attention Radar.
 *
 * Desktop-first (clipboard watching + source-app detection need Tauri); the
 * types themselves are platform-neutral.
 */

export type CaptureKind = "text" | "url" | "image"

/** Enrichment produced asynchronously after a capture is confirmed. */
export interface CaptureEnrichment {
  /** Clean markdown from the URL reader, or OCR text for an image. */
  markdown?: string
  /** Best-effort title (URL reader). */
  title?: string
  /** Which enricher produced this. */
  via?: "url-reader" | "ocr"
}

/** A confirmed, persisted capture (Dexie table `capturedItems`, v97). */
export interface CapturedItem {
  id: string
  kind: CaptureKind
  /** Raw text (text kind) or the URL string (url kind). */
  text?: string
  /** Normalized source URL (url kind). */
  sourceUrl?: string
  /** SHA-256 of the image bytes (image kind). */
  imageSha?: string
  /** Foreground app the content came from, when detectable. */
  sourceApp?: string
  capturedAt: number
  enrichment?: CaptureEnrichment
  /** SHA-256 dedup key (text / url / imageSha). */
  fingerprint: string
}

/** A pending capture awaiting user confirmation (not persisted). */
export interface CaptureCandidate {
  kind: CaptureKind
  text?: string
  sourceUrl?: string
  /** Data URL for an image candidate (used for preview + OCR). */
  imageDataUrl?: string
  sourceApp?: string
  fingerprint: string
}

export type CaptureMode = "confirm" | "silent" | "manual"

export interface CaptureSettings {
  /** Master switch for clipboard watching + capture. */
  enabled: boolean
  /**
   * `confirm` shows a bubble with a countdown; `silent` auto-saves with a
   * toast; `manual` only captures on an explicit action (no clipboard watch).
   */
  mode: CaptureMode
  /** Clipboard poll interval (ms). 0 disables polling. */
  pollIntervalMs: number
  /** Seconds before the confirm bubble auto-dismisses. */
  confirmTimeoutSec: number
  /** When true, capture is suspended (nothing read or stored). */
  privacyMode: boolean
}

export const DEFAULT_CAPTURE_SETTINGS: CaptureSettings = {
  enabled: false,
  mode: "confirm",
  pollIntervalMs: 2000,
  confirmTimeoutSec: 8,
  privacyMode: false,
}
