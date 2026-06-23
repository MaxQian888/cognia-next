"use client"

/**
 * Safely invoke a Tauri `listen()`-returned unlisten function.
 *
 * Tauri's injected `unregisterListener` (tauri 2.11, `src/event/mod.rs`
 * `unlisten_js_script`) evaluates `listeners[eventId].handlerId` while only
 * guarding the *per-event* object, not the *per-id* entry:
 *
 * ```js
 * const listeners = (window[OBJ] || {})[event]
 * if (listeners) {
 *   window.__TAURI_INTERNALS__.unregisterCallback(listeners[eventId].handlerId)
 * }
 * ```
 *
 * When a `listen()` registration eval has not yet run in the webview but another
 * listener for the same `event` already created the per-event object,
 * `listeners[eventId]` is `undefined` and `.handlerId` throws. React StrictMode's
 * mount→unmount→mount cycle triggers exactly this race (two subscribes + an early
 * unsubscribe for the same channel). Because Tauri's `_unlisten` is `async`, the
 * throw surfaces as an *unhandled promise rejection* rather than a synchronous
 * error catchable at the call site.
 *
 * Unlisten failing is harmless — it means the listener is already absent, which is
 * the desired post-condition — so we drop the rejection (and any synchronous
 * throw) instead of letting it crash the React tree.
 */
export function safeUnlisten(unlisten: (() => void | Promise<void>) | null | undefined): void {
  if (!unlisten) return
  let result: unknown
  try {
    result = unlisten()
  } catch {
    // Synchronous throw — same harmless already-gone case.
    return
  }
  if (result && typeof (result as Promise<unknown>).then === "function") {
    void (result as Promise<unknown>).catch(() => {})
  }
}
