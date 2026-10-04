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
    event: "appRestoredResult",
    handler: (event: RestoredAppResult) => void
  ): Promise<{ remove(): Promise<void> | void }>
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

export interface RestoredAppResult {
  pluginId: string
  methodName: string
  success: boolean
  data?: unknown
  error?: { message?: string }
}

/** Retained Android activity results are delivered when this listener registers. */
export async function subscribeRestoredResult(
  handler: (event: RestoredAppResult) => void,
  loader: AppLoader = defaultLoader
): Promise<Unsubscribe> {
  const app = await loader()
  const listener = await app.addListener("appRestoredResult", handler)
  return () => {
    void Promise.resolve()
      .then(() => listener.remove())
      .catch(() => undefined)
  }
}

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
 * policy must cover both branches itself (the handler lives in
 * `CompanionBootProvider`):
 *   - an open overlay first closes as Escape would close it
 *     (`dismissTopmostOverlayOnBack`), since most sheets/dialogs push no
 *     history entry and the press would otherwise act on the page under them.
 *   - `canGoBack` → `window.history.back()`. `useBackDismiss` overlays push a
 *     marker history entry, so this both dismisses those and pops SPA
 *     routes — identical to the old default.
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
