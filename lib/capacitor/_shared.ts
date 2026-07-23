"use client"

/**
 * Shared scaffolding for `lib/capacitor/*` wrappers.
 *
 * Every native plugin wrapper follows the same shape:
 *
 *   1. Declare a minimal `Shape` interface for the methods we call.
 *   2. Provide a `Loader` that dynamically imports the plugin module so
 *      the web bundle never resolves the native code.
 *   3. Dispatch through `withPlugin(loader, fn)` which returns a discriminated
 *      `unsupported` outcome on web/desktop.
 *
 * Keeping the platform detection and dynamic-import boilerplate in one place
 * lets each plugin file stay focused on its own API surface.
 */

import { detectPlatform, isNativeMobile, type Platform } from "@/lib/platform/detect"

/** @deprecated alias of {@link Platform} — kept so existing imports compile. */
export type NativePlatform = Platform

/**
 * Runtime platform. Delegates to the canonical {@link detectPlatform} in
 * `lib/platform/detect` so the `window`-marker logic lives in exactly one
 * place. Re-exported under this historical name for the plugin wrappers.
 */
export const detectNativePlatform = detectPlatform

export function isMobile(): boolean {
  return isNativeMobile()
}

/**
 * Common outcome surface for "fire and forget" native ops where the only
 * failure modes are unsupported runtime / unknown error. Operations that
 * have richer states (permission denied, cancelled, etc.) define their own
 * union but can re-use the `unsupported` and `error` branches verbatim.
 */
export type SimpleOutcome =
  { kind: "ok" } | { kind: "unsupported" } | { kind: "error"; message: string }

export type ValueOutcome<T> =
  { kind: "ok"; value: T } | { kind: "unsupported" } | { kind: "error"; message: string }

/**
 * Resolve a plugin loader and execute the action. Returns:
 *   - `unsupported` when the dynamic import rejects (web or missing native module)
 *   - `error` when the action throws
 *   - the action's own resolved value on success
 */
export async function withPlugin<P, R>(
  loader: () => Promise<P>,
  action: (plugin: P) => Promise<R>
): Promise<R | { kind: "unsupported" } | { kind: "error"; message: string }> {
  let plugin: P
  try {
    plugin = await loader()
  } catch {
    return { kind: "unsupported" }
  }
  try {
    return await action(plugin)
  } catch (err: unknown) {
    return {
      kind: "error",
      message: err instanceof Error ? err.message : String(err),
    }
  }
}

/**
 * Build a default loader that dynamic-imports a plugin module by name and
 * returns the named export. The `webpackIgnore` comment keeps the web bundle
 * from trying to resolve the native package.
 *
 * On web (no Tauri, no Capacitor native) the loader short-circuits with a
 * throw so `withPlugin` collapses to `{ kind: "unsupported" }`. Without
 * this guard, Capacitor's web shim returns a Proxy whose `.then` getter
 * throws ("Haptics.then() is not implemented on web") the moment we
 * `await` the resolved export — which would surface as an unhandled
 * rejection in tests and a confusing runtime crash for users who happen
 * to load the wrappers in plain browser context.
 */
/**
 * Read a Blob/File as a `data:` URL via `FileReader`. Used by the camera web
 * fallback (and any caller that needs to inline a picked file as base64)
 * without re-implementing the reader boilerplate.
 */
export function readFileAsDataUrl(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : "")
    reader.onerror = () => reject(reader.error ?? new Error("file read failed"))
    reader.readAsDataURL(file)
  })
}

/** Strip the `data:<mime>;base64,` prefix from a data URL, leaving raw base64. */
export function dataUrlToBase64(dataUrl: string): string {
  return dataUrl.includes(",") ? (dataUrl.split(",")[1] ?? "") : dataUrl
}

export function makeDefaultLoader<P>(moduleId: string, exportName: string): () => Promise<P> {
  return async () => {
    // Capacitor injects every plugin onto window.Capacitor.Plugins at boot.
    // In a production static-export the webpackIgnore import below usually
    // fails because the npm module is not in the bundle and there is no
    // node_modules inside the WebView. Falling back to the global keeps
    // splash-screen hide, haptics, status-bar, etc. working on device.
    // Checked first so a test that injects `window.Capacitor.Plugins.X`
    // resolves regardless of the detected platform.
    const capPlugins = (globalThis as unknown as { Capacitor?: { Plugins?: Record<string, P> } })
      .Capacitor?.Plugins
    const fromGlobal = capPlugins?.[exportName]
    if (fromGlobal) {
      return fromGlobal
    }
    // Capacitor plugins only exist on mobile. On `web` AND `tauri` the dynamic
    // import resolves to Capacitor's web-shim Proxy whose `.then` getter throws
    // ("X.then() is not implemented on web") the moment it's awaited. Gate the
    // import to mobile so `withPlugin` collapses to `{ kind: "unsupported" }`
    // everywhere else instead of surfacing that proxy throw (which broke the
    // biometric guard's graceful-degradation path under Tauri).
    if (detectNativePlatform() !== "mobile") {
      throw new Error(`${moduleId} not available on ${detectNativePlatform()}`)
    }
    const mod = (await import(/* webpackIgnore: true */ moduleId)) as Record<string, unknown>
    const exported = mod[exportName]
    if (!exported) {
      throw new Error(`Plugin module ${moduleId} did not export ${exportName}`)
    }
    return exported as P
  }
}
