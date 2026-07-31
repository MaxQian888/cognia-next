// Per-plugin ring buffer for python host notifications (log / progress /
// chunk / chunk_end / exit) fed by the `plugin:python` Tauri event, consumed
// by the plugin detail Logs tab. Subscribe API mirrors
// `lib/plugin/contracts/diagnostics-store.ts` (module-level store +
// listener set) so UI code can use the same useSyncExternalStore pattern.

import { dispatchPythonPluginEvent } from "./event-bus"

/** Wire payload of one `plugin:python` event (see events.rs PythonEvent). */
export interface PythonPluginEvent {
  pluginId: string
  kind: "log" | "progress" | "chunk" | "chunk_end" | "exit" | (string & {})
  callId?: number
  data: unknown
}

/** Buffered entry: the event plus an arrival timestamp. */
export interface PythonLogEntry extends PythonPluginEvent {
  ts: number
}

/** Ring capacity per plugin — old entries drop off the front. */
export const PYTHON_LOG_BUFFER_CAP = 500

const buffers = new Map<string, PythonLogEntry[]>()
const listeners = new Set<(pluginId: string) => void>()

/** Snapshot cache so getPythonLogs is referentially stable between writes
 *  (required by useSyncExternalStore). */
const snapshots = new Map<string, readonly PythonLogEntry[]>()

function notify(pluginId: string): void {
  snapshots.delete(pluginId)
  for (const listener of listeners) {
    try {
      listener(pluginId)
    } catch {
      // A broken subscriber must never break event ingestion.
    }
  }
}

/** Append one event to its plugin's ring buffer. */
export function appendPythonEvent(event: PythonPluginEvent, ts: number = Date.now()): void {
  if (!event || typeof event.pluginId !== "string" || event.pluginId.length === 0) {
    return
  }
  let buffer = buffers.get(event.pluginId)
  if (!buffer) {
    buffer = []
    buffers.set(event.pluginId, buffer)
  }
  buffer.push({ ...event, ts })
  if (buffer.length > PYTHON_LOG_BUFFER_CAP) {
    buffer.splice(0, buffer.length - PYTHON_LOG_BUFFER_CAP)
  }
  notify(event.pluginId)
  // This is the single ingestion point for `plugin:python` frames, so it also
  // fans out to runtime consumers (streamed chunks / plugin→host pushes for
  // python-backed contributions). Dispatch last: buffering must not depend on
  // a subscriber behaving.
  dispatchPythonPluginEvent(event)
}

/** Stable snapshot of a plugin's buffered entries (oldest first). */
export function getPythonLogs(pluginId: string): readonly PythonLogEntry[] {
  const cached = snapshots.get(pluginId)
  if (cached) {
    return cached
  }
  const snapshot = Object.freeze([...(buffers.get(pluginId) ?? [])])
  snapshots.set(pluginId, snapshot)
  return snapshot
}

/** Drop everything buffered for one plugin. */
export function clearPythonLogs(pluginId: string): void {
  buffers.delete(pluginId)
  notify(pluginId)
}

/** Subscribe to buffer changes; the callback receives the plugin id that
 *  changed. Returns the unsubscribe function. */
export function subscribePythonLogs(listener: (pluginId: string) => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Test-only: wipe all buffers and listeners. */
export function __resetPythonLogBufferForTesting(): void {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("__resetPythonLogBufferForTesting is test-only")
  }
  buffers.clear()
  snapshots.clear()
  listeners.clear()
}
