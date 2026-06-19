/**
 * TypeScript mirror of `src-tauri/src/automation/record/session.rs`.
 *
 * **Source of truth lives on the Rust side.** Field names are camelCase to match
 * the serde `rename_all = "camelCase"` (+ `rename_all_fields`) attributes on the
 * Rust structs/enums. If you change a field here, change it there too.
 *
 * Reuses the shared automation types (`Screenshot` / `ElementInfo` /
 * `MonitorInfo` / `Point`) so the recorder and the automation client stay in
 * lockstep.
 */

import type { ElementInfo, MonitorInfo, Point, Screenshot } from "@/lib/automation/types"

/** One captured user action, coarsely coalesced (double-clicks / key runs / scroll bursts). */
export type ObservationKind = "click" | "key" | "scroll"

/** Where a per-step screenshot lives. Inline carries base64 bytes (default). */
export type ScreenshotRef =
  | { kind: "inline"; shot: Screenshot }
  | { kind: "file"; path: string; width: number; height: number; capturedAt: number }

export interface Observation {
  seq: number
  tsMs: number
  kind: ObservationKind
  point?: Point
  element?: ElementInfo
  screenshot?: ScreenshotRef
  /** Lossy printable reconstruction of a typed key run — a hint, not a transcript. */
  textHint?: string
  scrollDy?: number
}

export interface RecordingTrace {
  sessionId: string
  startedAt: number
  endedAt: number
  observations: Observation[]
  monitors: MonitorInfo[]
}

export interface RecordStatus {
  recording: boolean
  sessionId?: string
  stepCount: number
  startedAt?: number
}

/** Live progress event emitted on the `record:event` channel during a session. */
export type RecordEvent =
  | { type: "started"; sessionId: string; startedAt: number }
  | { type: "step"; observation: Observation }
  | { type: "stopped"; stepCount: number }
  | { type: "cancelled" }
  | { type: "error"; message: string }

/** Options accepted by `record_start`. */
export interface RecordStartArgs {
  /** Return screenshots inline as base64 (default true) so the UI can keep them as resources. */
  inlineScreenshots?: boolean
  maxWidth?: number
  maxHeight?: number
}

/**
 * Extract the base64 PNG bytes from an observation's screenshot, if it is
 * inline. File-backed refs return `null` (the UI would need a Tauri fs read to
 * materialize them; the default recording path is inline).
 */
export function inlineScreenshotBytes(obs: Observation): string | null {
  const ref = obs.screenshot
  if (ref && ref.kind === "inline") return ref.shot.bytes
  return null
}
