// Resolves which window "role" the current webview is playing. The pet
// subsystem mounts its controller (event bus + XP awards) exactly once, in the
// main window; the transparent desktop-pet overlay (`/pet-overlay`, window
// label "pet") must render presentation only. Getting this wrong double-awards
// XP because the shared root layout mounts `PetMount` in every window.
//
// On the web there is a single browsing context → always "web". Under Tauri we
// read the current webview's label synchronously. `@tauri-apps/api` exposes the
// label only via the async `getCurrentWebviewWindow()` wrapper, but its
// internals read a synchronous global: `getCurrentWebview()` returns
// `window.__TAURI_INTERNALS__.metadata.currentWebview.label` (see
// node_modules/@tauri-apps/api/webview.js:28; the window variant lives at
// metadata.currentWindow.label, window.js:85). We replicate that read here so
// callers can gate render output without awaiting.

import { isTauri } from "@/lib/platform/detect"

export type PetWindowRole =
  "main" | "overlay" | "popup" | "island" | "selection-toolbar" | "tray-panel" | "web"

/** Label given to the desktop-pet overlay window by the Rust `open_pet_window`. */
export const PET_WINDOW_LABEL = "pet"

/**
 * Label given to the desktop-pet click popup window by the Rust
 * `open_pet_popup`. Kept in lockstep with `pet_window/popup.rs:PET_POPUP_LABEL`.
 */
export const PET_POPUP_WINDOW_LABEL = "pet-popup"

/**
 * Label given to the fleet agent-monitor island overlay by the Rust
 * `open_island_window`. Kept in lockstep with
 * `fleet/island_window.rs:ISLAND_LABEL`.
 */
export const ISLAND_WINDOW_LABEL = "island"

/** Label for the transient system text-selection toolbar window. */
export const SELECTION_TOOLBAR_WINDOW_LABEL = "selection-toolbar"

/**
 * Label given to the tray quick-panel popover by the Rust `open_tray_panel`.
 * Kept in lockstep with `tray/panel.rs:TRAY_PANEL_LABEL`.
 */
export const TRAY_PANEL_WINDOW_LABEL = "tray-panel"

interface TauriInternalsShape {
  metadata?: {
    currentWebview?: { label?: string }
    currentWindow?: { label?: string }
  }
}

/**
 * Read the current webview's label synchronously from the Tauri internals,
 * falling back to the window label, then to "main" when neither is present.
 */
function readWebviewLabel(): string | undefined {
  if (typeof window === "undefined") return undefined
  const internals = (window as unknown as { __TAURI_INTERNALS__?: TauriInternalsShape })
    .__TAURI_INTERNALS__
  const meta = internals?.metadata
  return meta?.currentWebview?.label ?? meta?.currentWindow?.label
}

/**
 * Resolve the pet window role.
 *
 * - Non-Tauri runtime → "web".
 * - Tauri, label "pet" → "overlay".
 * - Tauri, label "pet-popup" → "popup".
 * - Tauri, any other label (or missing) → "main".
 *
 * Both "overlay" and "popup" are secondary pet windows that must render
 * presentation only — `PetMount` mounts the controller (event bus + XP awards)
 * solely in "main"/"web", or XP double-awards.
 *
 * @param getLabel Optional DI seam for tests; defaults to the synchronous
 *   Tauri internals read.
 */
export function getPetWindowRole(
  getLabel: () => string | undefined = readWebviewLabel
): PetWindowRole {
  if (!isTauri()) return "web"
  const label = getLabel()
  if (label === PET_WINDOW_LABEL) return "overlay"
  if (label === PET_POPUP_WINDOW_LABEL) return "popup"
  if (label === ISLAND_WINDOW_LABEL) return "island"
  if (label === SELECTION_TOOLBAR_WINDOW_LABEL) return "selection-toolbar"
  if (label === TRAY_PANEL_WINDOW_LABEL) return "tray-panel"
  return "main"
}

/**
 * True for the transparent secondary overlay windows (pet sprite, pet popup,
 * fleet island). These load the shared root layout but must render
 * presentation only: no controllers, no wallpaper, no account gate, no
 * boot-time initializers — they are least-privilege windows whose denied
 * capabilities would otherwise log spurious warnings (and the pet controller
 * would double-award XP).
 */
export function isSecondaryOverlayRole(role: PetWindowRole): boolean {
  return (
    role === "overlay" ||
    role === "popup" ||
    role === "island" ||
    role === "selection-toolbar" ||
    role === "tray-panel"
  )
}

/**
 * True when the current webview runs the full app runtime — the main desktop
 * window or the browser/Capacitor shell ("main" / "web").
 *
 * The transparent pet overlay/popup windows load this same root layout but are
 * least-privilege (see `src-tauri/capabilities/pet.json`): they are granted
 * neither the notification, autostart, store, CLI, deep-link, nor
 * window-set-title permissions. Any boot-time hook that touches those APIs must
 * gate on this so it no-ops in a pet window instead of logging a
 * denied-capability warning. Mirrors the `role === "main" || "web"` gate
 * already used by `SettingsSyncProvider`.
 *
 * @param getLabel Optional DI seam for tests; forwarded to {@link getPetWindowRole}.
 */
export function isMainAppWindow(getLabel: () => string | undefined = readWebviewLabel): boolean {
  const role = getPetWindowRole(getLabel)
  return role === "main" || role === "web"
}
