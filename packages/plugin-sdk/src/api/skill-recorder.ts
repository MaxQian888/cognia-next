/**
 * Plugin SDK — `skill-recorder` capability surface.
 *
 * Desktop skill recording is a host feature with a plugin-shaped hole in the
 * middle: the native capture (global input hook, recorder window, bundle
 * store) is the host's, but whether the feature EXISTS at all is a plugin's
 * answer. The entry points across the app render nothing until a plugin calls
 * `setRecorderAvailability({ available: true, pluginId })`, and they disappear
 * again on `clearRecorderAvailability()`. That pair is the contract, and a
 * plugin owning it could not previously reach it without a host-private
 * import.
 *
 * `recordStatus()` and the rest of the client are the read/drive side — the
 * Tauri commands behind the recorder. They only resolve on the desktop shell;
 * check `readHostCapabilities().tauri` (or `ctx.capabilities.tauri`) first
 * rather than catching the rejection.
 */

export {
  clearRecorderAvailability,
  getRecorderAvailability,
  setRecorderAvailability,
  subscribeRecorderAvailability,
} from "@/lib/skills/recording/recorder-availability"

export type { RecorderAvailability } from "@/lib/skills/recording/recorder-availability"

export {
  RECORD_EVENT_CHANNEL,
  recordDeleteBundle,
  recordInterrupt,
  recordListCaptureTargets,
  recordListRecoverable,
  recordLoadBundle,
  recordPause,
  recordPreflight,
  recordReadAsset,
  recordResume,
  recordStart,
  recordStatus,
  recordStop,
  recordUndoLast,
} from "@/lib/skills/recording/recorder-client"

/**
 * Opening the recorder UI. `openRecorder()` is what a slash command or tray
 * item calls; `recorderStatusSnapshot()` is the synchronous read a tool uses
 * to answer "is a recording in progress?" without a round trip.
 */
export { openRecorder, recorderStatusSnapshot } from "@/stores/skills/recorder-store"
