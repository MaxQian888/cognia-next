/**
 * Canonical, framework-free platform detection.
 *
 * This is the SINGLE source of truth for "which runtime is this webview?" and
 * for the device's input capabilities. Everything else — `usePlatform()`,
 * `detectNativePlatform()` (lib/capacitor), `isTauri()` / `isCapacitor()`
 * (lib/tauri) — delegates here so the `window`-marker logic exists in exactly
 * one place and can never drift.
 *
 * Pure leaf: imports nothing from `@/lib/tauri`, `@/lib/capacitor`, or React,
 * so both non-React `lib/` code and the React hooks can depend on it without a
 * circular import.
 */

/**
 * Runtime of the active webview.
 *
 * - `tauri`  — Tauri desktop shell. `__TAURI_INTERNALS__` is on `window`.
 * - `mobile` — Capacitor mobile shell. `window.Capacitor.isNativePlatform()` is true.
 * - `web`    — vanilla browser, dev mode, or a server-rendered initial paint.
 * - `headless` — the Node brain process serving a headless Cognia host.
 *
 * The runtime never changes after first paint, so callers memoize freely.
 */
export type Platform = "tauri" | "mobile" | "web" | "headless"

type CapacitorGlobal = { Capacitor?: { isNativePlatform?: () => boolean } }

function capacitorIsNative(): boolean {
  const cap = (window as unknown as CapacitorGlobal).Capacitor
  return typeof cap?.isNativePlatform === "function" && cap.isNativePlatform() === true
}

/**
 * Resolve the runtime. `tauri` wins over `mobile` if both markers somehow
 * appear (a Tauri build never bundles Capacitor, so this only guards the
 * pathological case deterministically).
 */
export function detectPlatform(): Platform {
  // The brain installs a window shim on globalThis, so host detection must
  // precede every browser/WebView marker check.
  if (isHeadlessHost()) return "headless"
  if (typeof window === "undefined") return "web"
  if ("__TAURI_INTERNALS__" in window) return "tauri"
  if (capacitorIsNative()) return "mobile"
  return "web"
}

/** True inside a Tauri desktop webview. */
export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window
}

/**
 * True inside a Capacitor *native* mobile shell. Mirrors the historical
 * `lib/tauri` semantics: keyed purely on `Capacitor.isNativePlatform()`,
 * independent of the Tauri marker.
 */
export function isCapacitor(): boolean {
  return typeof window !== "undefined" && capacitorIsNative()
}

/**
 * True inside the headless brain process (`cognia-agent serve`, ADR-0059
 * T-A10). The serve boot sets the `__COGNIA_HEADLESS__` marker before any
 * lib module runs; browsers/WebViews never have it. Distinct from
 * {@link detectPlatform} — headless is a HOST property, not a webview kind
 * (there is no webview at all).
 */
export function isHeadlessHost(): boolean {
  return (globalThis as Record<string, unknown>).__COGNIA_HEADLESS__ === true
}

/**
 * True inside the standalone `cognia-agent` CLI process.
 *
 * Like {@link isHeadlessHost} this is a HOST property, not a webview kind, and
 * for the same reason it is a marker rather than a sniff: the CLI is a Node
 * process with no `window` of its own, which is indistinguishable from SSR by
 * inspection alone. `cli/src/cli/entry.ts` sets `__COGNIA_CLI__` on the CLI
 * role before any `@/lib` module is imported.
 *
 * Deliberately NOT folded into {@link detectPlatform}: the CLI resolves to
 * `web` there, sixty call sites branch on that answer, and re-labelling the
 * runtime to fix one gate would change all of them at once. What the CLI
 * actually needs said about it is narrower — it owns a process table — and
 * that is asked and answered where it matters
 * (`lib/ai/agent/external/process-plane.ts`).
 */
export function isCliHost(): boolean {
  return (globalThis as Record<string, unknown>).__COGNIA_CLI__ === true
}

/**
 * True when the resolved runtime is native mobile. Uses {@link detectPlatform}
 * precedence (so a stray Tauri marker downgrades it to non-mobile). This is the
 * predicate viewport hooks use to pin themselves to the mobile layout.
 */
export function isNativeMobile(): boolean {
  return detectPlatform() === "mobile"
}

/** Pointer / hover capabilities of the device. */
export interface InputCapabilities {
  /** The primary pointer can hover (mouse/trackpad), not just tap. */
  hasHover: boolean
  /** The primary pointer is coarse (finger/stylus) rather than a fine mouse. */
  coarsePointer: boolean
}

/**
 * Detect input capabilities via `matchMedia`. SSR / no-`matchMedia` falls back
 * to a desktop-like assumption (`hasHover: true`, `coarsePointer: false`),
 * matching the desktop-default SSR snapshot used by the viewport hooks so the
 * server and first client render agree.
 */
export function detectInputCapabilities(): InputCapabilities {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return { hasHover: true, coarsePointer: false }
  }
  return {
    hasHover: window.matchMedia("(hover: hover)").matches,
    coarsePointer: window.matchMedia("(pointer: coarse)").matches,
  }
}
