/**
 * Out-of-React lookup for per-workflow editor stores. (Phase C.2)
 *
 * Inside the React tree, callers reach the active editor store via
 * `EditorStoreProvider` + `useEditorStore()` (see `./store-context.tsx`).
 * Plugin-tool handlers registered through `PluginToolsBridge` fire from
 * stdio callbacks OUTSIDE the React tree — they can't use hooks. This
 * registry gives them an O(1) lookup keyed on the workflow id the
 * `EditorStoreProvider` mounted for.
 *
 * Registration is owned by the provider (`store-context.tsx`) so the
 * registry never drifts from the React lifecycle — when the editor
 * unmounts, the entry disappears and tool handlers correctly fail with
 * `editor-not-open` instead of silently mutating a stale store.
 */

import type { EditorStore } from "./store"

type Listener = () => void

const stores = new Map<string, EditorStore>()
const listeners = new Set<Listener>()

/** Notify any subscribers that the registry contents changed. */
function notify(): void {
  for (const l of listeners) l()
}

/**
 * Register an editor store for `workflowId`. Idempotent: re-registering
 * the same store is a no-op; re-registering a DIFFERENT store for an
 * already-occupied id logs a warning and overwrites (this only happens
 * during HMR or in test setups that don't tear down cleanly).
 */
export function registerEditorStore(workflowId: string, store: EditorStore): void {
  const existing = stores.get(workflowId)
  if (existing === store) return
  if (existing && process.env.NODE_ENV !== "production") {
    console.warn(
      `[workflow-editor-registry] overwriting store for workflowId=${workflowId} — most likely a stale provider from HMR.`
    )
  }
  stores.set(workflowId, store)
  notify()
}

/**
 * Unregister the store for `workflowId`. No-op if not present.
 */
export function unregisterEditorStore(workflowId: string): void {
  if (!stores.has(workflowId)) return
  stores.delete(workflowId)
  notify()
}

/**
 * Look up an editor store by workflow id. Returns `null` if no editor
 * for that workflow is currently mounted — plugin tools should surface a
 * typed error in that case rather than throwing.
 */
export function getEditorStore(workflowId: string): EditorStore | null {
  return stores.get(workflowId) ?? null
}

/**
 * Return every (workflowId, store) pair currently registered. Used by
 * the workflow-ai plugin when a tool call arrives without an explicit
 * workflow id and there's exactly one editor open — the only safe
 * "implicit target" case.
 */
export function listEditorStores(): ReadonlyArray<{ workflowId: string; store: EditorStore }> {
  const out: Array<{ workflowId: string; store: EditorStore }> = []
  for (const [workflowId, store] of stores) out.push({ workflowId, store })
  return out
}

/**
 * Subscribe to registry mutations. Returns an unsubscribe function. Used
 * by debug surfaces that want to live-render "which editors are open".
 */
export function subscribeEditorStores(listener: Listener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/**
 * Test helper: wipe the registry. Production code should never call
 * this — it's exported for unit tests that reuse the module across
 * cases.
 */
export function __resetRegistryForTesting(): void {
  stores.clear()
  listeners.clear()
}
