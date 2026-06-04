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

export type PetWindowRole = "main" | "overlay" | "web"

/** Label given to the desktop-pet overlay window by the Rust `open_pet_window`. */
export const PET_WINDOW_LABEL = "pet"

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
 * - Tauri, any other label (or missing) → "main".
 *
 * @param getLabel Optional DI seam for tests; defaults to the synchronous
 *   Tauri internals read.
 */
export function getPetWindowRole(
  getLabel: () => string | undefined = readWebviewLabel
): PetWindowRole {
  if (!isTauri()) return "web"
  const label = getLabel()
  return label === PET_WINDOW_LABEL ? "overlay" : "main"
}
