/**
 * The plugin contract's share of `lib/platform/detect.ts`, which re-exports these.
 */
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
