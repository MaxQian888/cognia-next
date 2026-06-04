// Guarantees the Cubism Core global (`window.Live2DCubismCore`) exists before
// the Live2D engine module is imported (the engine self-registers its runtime on
// import, so the only job here is making the global present). The core script is
// served locally from `public/live2d/` (dropped by the build script) so Tauri's
// strict CSP and offline runs still work.
//
// The in-flight promise is cached module-level so concurrent callers share one
// injection. `resetCubismCoreLoaderForTests` clears that cache between tests
// (mirrors the `configured` flag in lib/canvas/monaco-loader.ts).

import { CUBISM_CORE_PUBLIC_PATH } from "./constants"

export interface EnsureCoreDeps {
  /** Inject a script tag (or equivalent) for `src`; resolve on load. */
  injectScript?: (src: string) => Promise<void>
  /** Read the current core global. */
  getCore?: () => unknown
}

let inFlight: Promise<boolean> | null = null

/** Clear the cached in-flight promise. Test-only. */
export function resetCubismCoreLoaderForTests(): void {
  inFlight = null
}

function defaultGetCore(): unknown {
  return typeof window === "undefined"
    ? undefined
    : (window as unknown as { Live2DCubismCore?: unknown }).Live2DCubismCore
}

function defaultInjectScript(src: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (typeof document === "undefined") {
      reject(new Error("noDocument"))
      return
    }
    const script = document.createElement("script")
    script.src = src
    script.async = true
    script.onload = () => resolve()
    script.onerror = () => reject(new Error("scriptError"))
    document.head.appendChild(script)
  })
}

/**
 * Resolve `true` once the Cubism Core global is present. If it is already
 * loaded, returns immediately; otherwise injects the local core script and
 * re-checks. Any injection failure resolves `false` (the caller falls back to
 * the SVG skin).
 */
export function ensureCubismCore(deps: EnsureCoreDeps = {}): Promise<boolean> {
  const getCore = deps.getCore ?? defaultGetCore
  const injectScript = deps.injectScript ?? defaultInjectScript

  if (getCore()) {
    return Promise.resolve(true)
  }

  if (inFlight) return inFlight

  inFlight = (async () => {
    try {
      await injectScript(CUBISM_CORE_PUBLIC_PATH)
    } catch {
      return false
    }
    return Boolean(getCore())
  })()

  return inFlight
}
