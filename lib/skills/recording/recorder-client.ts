/**
 * Typed wrappers over the Rust skill-recorder Tauri commands + the
 * `record:event` channel. This is the SOLE seam between the recorder UI/store
 * and the native backend
 * (`crates/cognia-automation/src/automation/record/commands.rs`).
 *
 * Desktop-only: recording needs a global input hook. On non-Tauri runtimes the
 * `transport` web stub rejects, so callers guard with `isTauri()` and surface a
 * "desktop only" message rather than calling these blindly.
 *
 * Note what is *not* here: there is no `recordCancel`. Cancelling used to delete
 * the capture directory, which is exactly what the append-only journal forbids.
 * Ending a recording keeps the bundle ([`recordStop`] / [`recordInterrupt`]);
 * destroying one is a separate, explicit act ([`recordDeleteBundle`]).
 */

import { transport } from "@/lib/tauri"
import type {
  AssetId,
  AssetPayload,
  CaptureTarget,
  RecordEvent,
  RecordPreflight,
  RecordStartArgs,
  RecordStatus,
  RecordingBundle,
  RecordingId,
  RecoverableBundle,
} from "./types"

export const RECORD_EVENT_CHANNEL = "record:event"

/** Event the always-on-top controller listens on for collapse-state changes. */
export const RECORDER_CONTROLLER_EVENT = "recorder:controller"

/**
 * Switch the floating controller between the expanded strip and the collapsed
 * pill. Deliberately not a hide: while a recording runs there must always be
 * something on screen that can stop it, which is why the controller window's
 * capability grants no `core:window:allow-close` or `allow-hide`.
 */
export function recorderControllerSetCollapsed(collapsed: boolean): Promise<void> {
  return transport.call<void>("recorder_controller_set_collapsed", { collapsed })
}

/**
 * Begin an OS-level drag of the controller. Works on the non-activating panel
 * without stealing focus from whatever is being recorded.
 */
export function recorderControllerBeginDrag(): Promise<void> {
  return transport.call<void>("recorder_controller_begin_drag")
}

/** What blocks a recording on this machine right now, and why. */
export function recordPreflight(): Promise<RecordPreflight> {
  return transport.call<RecordPreflight>("record_preflight")
}

/**
 * Windows the user can scope a recording to, ours excluded.
 *
 * Unprivileged: it arms nothing and returns only titles already visible on the
 * user's own screen, so it faces no gate and raises no consent prompt.
 */
export function recordListCaptureTargets(): Promise<CaptureTarget[]> {
  return transport.call<CaptureTarget[]>("record_list_capture_targets")
}

/**
 * Arm a recording.
 *
 * Faces the full automation gate Rust-side: the kill switch, the master disable,
 * the plugin's grants and the whitelist all reject *before* a consent prompt is
 * raised; a prompt that does appear is one-shot and can never become a
 * "don't ask again" grant.
 */
export function recordStart(args: RecordStartArgs): Promise<RecordStatus> {
  return transport.call<RecordStatus>("record_start", { args })
}

/**
 * Suspend capture. Resolves only after the buffered key run is committed and on
 * disk — a half-typed word is not lost by pausing.
 */
export function recordPause(): Promise<RecordStatus> {
  return transport.call<RecordStatus>("record_pause")
}

export function recordResume(): Promise<RecordStatus> {
  return transport.call<RecordStatus>("record_resume")
}

/** Drop the most recent step. Journals a tombstone and deletes only its frame. */
export function recordUndoLast(): Promise<RecordStatus> {
  return transport.call<RecordStatus>("record_undo_last")
}

/** Finish the recording and return the bundle, replayed from disk. */
export function recordStop(): Promise<RecordingBundle> {
  return transport.call<RecordingBundle>("record_stop")
}

/** End a recording without discarding it; it stays in the recoverable list. */
export function recordInterrupt(): Promise<void> {
  return transport.call<void>("record_interrupt")
}

/** Current recorder status. Backstops a late-mounting UI and drives reattach. */
export function recordStatus(): Promise<RecordStatus> {
  return transport.call<RecordStatus>("record_status")
}

/** Every bundle on disk that was never finished. Nothing is auto-deleted. */
export function recordListRecoverable(): Promise<RecoverableBundle[]> {
  return transport.call<RecoverableBundle[]>("record_list_recoverable")
}

export function recordLoadBundle(recordingId: RecordingId): Promise<RecordingBundle> {
  return transport.call<RecordingBundle>("record_load_bundle", { recordingId })
}

/**
 * Fetch one frame as base64.
 *
 * Frames are read on demand rather than streamed with the bundle: a 400-step
 * recording is hundreds of megabytes, and the review UI only ever shows a
 * handful at a time.
 */
export function recordReadAsset(recordingId: RecordingId, assetId: AssetId): Promise<AssetPayload> {
  return transport.call<AssetPayload>("record_read_asset", { recordingId, assetId })
}

/** Destroy a bundle: its journal, its manifest and every frame. */
export function recordDeleteBundle(recordingId: RecordingId): Promise<void> {
  return transport.call<void>("record_delete_bundle", { recordingId })
}

/**
 * Subscribe to live recorder progress. Returns an unlisten function; calling it
 * more than once is safe.
 */
export function onRecordEvent(handler: (event: RecordEvent) => void): () => void {
  return transport.subscribe<RecordEvent>(RECORD_EVENT_CHANNEL, handler)
}
