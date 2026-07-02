/**
 * Headless runtime roster — THE wiring anchor (ADR-0059 W2 / T-A1).
 *
 * `cli/src/serve` imports this module once at boot; importing it registers
 * every extracted runtime into the registry. The wiring auditor enforces the
 * repo rule that new provider effects either register here or carry a
 * desktop-ui-only annotation below.
 *
 * ## Registered (extraction slices T-A2..A9 add entries here)
 *
 * (none yet — T-A2 lands `desktop-sync-source` first)
 *
 * ## Deliberately NOT registered (desktop/mobile-UI-only provider effects)
 *
 * - `companion-boot` — the CLIENT side of the companion protocol (pairing,
 *   sync-down into a phone); a brain is the server side.
 * - `storage-persistence` — `navigator.storage.persist()` is a browser API.
 * - `window-title`, `context-keys`, `appearance` — WebView chrome/UI state.
 * - `ocr-runtime` — native OCR is desktop-only hardware (ADR-0059 D4).
 * - `desktop-only-initializers` / `mobile-only-initializers` — shell-specific
 *   by definition; anything inside them that belongs in the brain must be
 *   extracted out and registered individually.
 * - `pet` — desktop pet window runtime.
 */

// Extraction slices append `registerHeadlessRuntime(...)` calls (or runtime
// module imports) here, e.g.:
//   import "./desktop-sync-source"

export {}
