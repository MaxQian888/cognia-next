/**
 * Fan-out for `plugin:python` host events.
 *
 * `PluginManager.subscribePythonEvents` owns the *single* Tauri listener for
 * the `plugin:python` channel and feeds every frame to `appendPythonEvent`
 * (the per-plugin UI ring buffer), which dispatches here. Runtime consumers —
 * notably the python-backed contribution proxy
 * (`lib/plugin/bridge/_shared/python-backed-proxy.ts`) — subscribe through this
 * bus for streamed chunks and plugin→host pushes instead of opening a second
 * listener, so there is exactly one ingestion point to reason about.
 *
 * Kept deliberately dependency-free (type-only import) so bridge modules can
 * use it without dragging `PluginManager` into their import graph — the
 * manager already imports the bridges, so the reverse edge would be a cycle.
 */

import type { PythonPluginEvent } from "./log-buffer"

export type PythonPluginEventListener = (event: PythonPluginEvent) => void

const listeners = new Set<PythonPluginEventListener>()

/**
 * Subscribe to every `plugin:python` frame, for every plugin. Callers filter by
 * `pluginId` (and, for streamed calls, by the seam's `streamId`) themselves.
 *
 * @returns an unsubscribe function; calling it twice is safe.
 */
export function subscribePythonPluginEvents(listener: PythonPluginEventListener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/**
 * Broadcast one frame. Called from `appendPythonEvent`, the single ingestion
 * point — never call this from feature code.
 */
export function dispatchPythonPluginEvent(event: PythonPluginEvent): void {
  // Snapshot: a listener may unsubscribe (or subscribe) during dispatch.
  for (const listener of [...listeners]) {
    try {
      listener(event)
    } catch {
      // A broken subscriber must never break event ingestion — mirrors the
      // ring buffer's notify().
    }
  }
}

/** Number of live subscribers — diagnostics and leak assertions in tests. */
export function pythonPluginEventListenerCount(): number {
  return listeners.size
}

/** Test-only: drop every subscriber. */
export function __resetPythonEventBusForTesting(): void {
  listeners.clear()
}
