"use client"

import { makeDefaultLoader } from "./_shared"

/**
 * `@capacitor/app` wrapper.
 *
 * The plugin emits state transitions (`appStateChange`, `resume`, `pause`,
 * `backButton`, etc.). The companion sync orchestrator and the outbound
 * queue both need a "the user just brought us back to the foreground"
 * signal so they can re-pull deltas and drain pending writes.
 *
 * On web / Tauri the wrapper falls back to `visibilitychange === "visible"`,
 * which is the closest browser equivalent.
 */

interface AppPluginShape {
  addListener(
    event: "resume",
    handler: () => void
  ): Promise<{ remove(): Promise<void> } | { remove(): void }>
}

export type AppLoader = () => Promise<AppPluginShape>

const defaultLoader: AppLoader = makeDefaultLoader<AppPluginShape>("@capacitor/app", "App")

export type Unsubscribe = () => void

/**
 * Subscribe to "app resumed to foreground" events.
 *
 * Returns an unsubscribe function. Always resolves — never throws — even
 * when the plugin import fails (web / Tauri), so call sites can use it
 * unconditionally inside `useEffect` cleanup arrays.
 */
export async function subscribeResume(
  handler: () => void,
  loader: AppLoader = defaultLoader
): Promise<Unsubscribe> {
  try {
    const app = await loader()
    const listener = await app.addListener("resume", handler)
    const remove = listener as { remove: () => void | Promise<void> }
    return () => {
      void remove.remove()
    }
  } catch {
    if (typeof document === "undefined") return () => {}
    const onVisible = () => {
      if (document.visibilityState === "visible") handler()
    }
    document.addEventListener("visibilitychange", onVisible)
    return () => document.removeEventListener("visibilitychange", onVisible)
  }
}
