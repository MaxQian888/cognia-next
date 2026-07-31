"use client"

import { makeDefaultLoader, withPlugin, type ValueOutcome } from "./_shared"

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
  addListener(
    event: "backButton",
    handler: (event: { canGoBack: boolean }) => void
  ): Promise<{ remove(): Promise<void> } | { remove(): void }>
  getInfo(): Promise<{ name: string; version: string; build: string; id: string }>
  minimizeApp(): Promise<void>
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
export interface NativeAppInfo {
  name: string
  version: string
  build: string
  id: string
}

/**
 * Read the native app's version/build via `App.getInfo()`. Resolves to
 * `unsupported` on web / Tauri (loader throws) so callers can fall back to
 * the bundled `APP_VERSION` without a try/catch.
 */
export async function getAppInfo(
  loader: AppLoader = defaultLoader
): Promise<ValueOutcome<NativeAppInfo>> {
  return withPlugin(loader, async (app) => {
    const info = await app.getInfo()
    return { kind: "ok" as const, value: info }
  })
}

/**
 * Take over the Android hardware back button.
 *
 * Registering a `backButton` listener DISABLES the Capacitor App plugin's
 * default handling (WebView history back, exit at root), so the installed
 * policy must cover both branches itself:
 *   - `canGoBack` → `window.history.back()`. Open sheets/dialogs push a
 *     marker history entry (`useBackDismiss`), so this both dismisses
 *     overlays and pops SPA routes — identical to the old default.
 *   - at the history root → `App.minimizeApp()` instead of the default
 *     exit, matching standard Android launcher-app UX.
 *
 * No-op (returns an inert unsubscribe) on web / Tauri, where the browser
 * back button already drives `popstate` natively.
 */
export async function subscribeBackButton(
  handler: (event: { canGoBack: boolean }) => void,
  loader: AppLoader = defaultLoader
): Promise<Unsubscribe> {
  try {
    const app = await loader()
    const listener = await app.addListener("backButton", handler)
    const remove = listener as { remove: () => void | Promise<void> }
    return () => {
      void remove.remove()
    }
  } catch {
    return () => {}
  }
}

/**
 * Minimize (background) the app — Android only. Used by the back-button
 * policy at the history root. Best-effort: resolves `unsupported` on
 * web / Tauri / iOS instead of throwing.
 */
export async function minimizeApp(
  loader: AppLoader = defaultLoader
): Promise<ValueOutcome<undefined>> {
  return withPlugin(loader, async (app) => {
    await app.minimizeApp()
    return { kind: "ok" as const, value: undefined }
  })
}

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
