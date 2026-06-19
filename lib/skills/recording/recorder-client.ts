/**
 * Typed wrappers over the Rust skill-recorder Tauri commands + the
 * `record:event` channel. This is the SOLE seam between the recorder UI/hooks
 * and the native backend (`src-tauri/src/automation/record/commands.rs`).
 *
 * Desktop-only: recording needs a global input hook. On non-Tauri runtimes the
 * `transport` web stub rejects, so callers should guard with `isTauri()` and
 * surface a "desktop only" message rather than calling these blindly.
 */

import { transport } from "@/lib/tauri"
import type { RecordEvent, RecordStartArgs, RecordStatus, RecordingTrace } from "./types"

const RECORD_EVENT_CHANNEL = "record:event"

/** Begin a recording session (prompts the user for consent first, Rust-side). */
export function recordStart(args?: RecordStartArgs): Promise<RecordStatus> {
  return transport.call<RecordStatus>("record_start", { args: args ?? {} })
}

/** Stop the session and return the captured trace. */
export function recordStop(): Promise<RecordingTrace> {
  return transport.call<RecordingTrace>("record_stop")
}

/** Read the current recorder status (backstops a late-mounting UI). */
export function recordStatus(): Promise<RecordStatus> {
  return transport.call<RecordStatus>("record_status")
}

/** Cancel the session, discarding the trace and any temp screenshots. */
export function recordCancel(): Promise<void> {
  return transport.call<void>("record_cancel")
}

/**
 * Subscribe to live recorder progress. Returns an unlisten function; calling it
 * more than once is safe.
 */
export function onRecordEvent(handler: (event: RecordEvent) => void): () => void {
  return transport.subscribe<RecordEvent>(RECORD_EVENT_CHANNEL, handler)
}
