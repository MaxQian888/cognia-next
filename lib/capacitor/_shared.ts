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

export type NativePlatform = "tauri" | "mobile" | "web"

export function detectNativePlatform(): NativePlatform {
  if (typeof window === "undefined") return "web"
  if ("__TAURI_INTERNALS__" in window) return "tauri"
  const cap = (window as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor
  if (typeof cap?.isNativePlatform === "function" && cap.isNativePlatform() === true) {
    return "mobile"
  }
  return "web"
}

export function isMobile(): boolean {
  return detectNativePlatform() === "mobile"
}

/**
 * Common outcome surface for "fire and forget" native ops where the only
 * failure modes are unsupported runtime / unknown error. Operations that
 * have richer states (permission denied, cancelled, etc.) define their own
 * union but can re-use the `unsupported` and `error` branches verbatim.
 */
export type SimpleOutcome =
  | { kind: "ok" }
  | { kind: "unsupported" }
  | { kind: "error"; message: string }

export type ValueOutcome<T> =
  | { kind: "ok"; value: T }
  | { kind: "unsupported" }
  | { kind: "error"; message: string }

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
 */
export function makeDefaultLoader<P>(moduleId: string, exportName: string): () => Promise<P> {
  return async () => {
    const mod = (await import(/* webpackIgnore: true */ moduleId)) as Record<string, unknown>
    const exported = mod[exportName]
    if (!exported) {
      throw new Error(`Plugin module ${moduleId} did not export ${exportName}`)
    }
    return exported as P
  }
}
