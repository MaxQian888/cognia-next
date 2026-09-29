/**
 * Renderer wrappers for the local-Chromium extension store (ADR-0201,
 * `src-tauri/src/browser/extensions.rs`). Extensions live unpacked under
 * `<app_data>/browser/extensions/<id>/`; every mutation reloads live local
 * sessions and emits `browser-local://event {type: "extensions.changed"}`.
 * The embedded webview and `user-chrome` never load this set.
 *
 * Installs are two-step: `prepare…` / `pick…` fetch or let the user pick the
 * package in a native dialog Rust shows (the renderer never names a path),
 * verify it and return what it asks for; nothing is installed until the user
 * confirms those permissions and the UI calls `confirmExtensionInstall`.
 */
import { transport } from "@/lib/tauri"

export type BrowserExtensionSource = "webstore" | "crx" | "unpacked"

export interface BrowserExtension {
  id: string
  name: string
  version: string
  enabled: boolean
  source: BrowserExtensionSource
  /** Epoch ms. */
  installedAt: number
  permissions: string[]
  hostPermissions: string[]
  iconPath: string | null
  popupPath: string | null
  optionsPath: string | null
  description: string | null
  /** Newer version seen by the last update check, when any. */
  updateAvailable?: string | null
}

/** A verified package waiting for the user to confirm its permissions. */
export interface PendingExtensionInstall {
  pendingId: string
  /** Fixed by CRX / Web Store packages; unpacked ids are derived at install. */
  id: string | null
  name: string
  version: string
  description: string | null
  permissions: string[]
  hostPermissions: string[]
  source: BrowserExtensionSource
}

export interface BrowserExtensionUpdate {
  id: string
  currentVersion: string
  availableVersion: string
}

/** Typed error codes Rust returns as the error string (or its prefix). */
export const BROWSER_EXTENSION_ERROR_CODES = [
  "extensions_unsupported_backend",
  "crx_invalid",
  "crx_id_mismatch",
  "zip_path_traversal",
  "manifest_invalid",
  "webstore_unavailable",
  "extension_not_found",
  "extension_install_expired",
] as const

export type BrowserExtensionErrorCode = (typeof BROWSER_EXTENSION_ERROR_CODES)[number]

/** Pull the stable code out of a rejected extension command, when it carries one. */
export function browserExtensionErrorCode(error: unknown): BrowserExtensionErrorCode | null {
  const text =
    typeof error === "string"
      ? error
      : error instanceof Error
        ? error.message
        : error && typeof error === "object" && "message" in error
          ? String((error as { message: unknown }).message)
          : ""
  return BROWSER_EXTENSION_ERROR_CODES.find((code) => text.includes(code)) ?? null
}

export function listExtensions(): Promise<BrowserExtension[]> {
  return transport.call<BrowserExtension[]>("browser_extensions_list")
}

/** Download and verify a Chrome Web Store extension (id or store URL). */
export function prepareWebStoreExtension(idOrUrl: string): Promise<PendingExtensionInstall> {
  return transport.call<PendingExtensionInstall>("browser_extension_install_webstore", {
    idOrUrl,
  })
}

/** Rust shows a `.crx` file picker; `null` when it was cancelled. */
export function pickCrxExtension(): Promise<PendingExtensionInstall | null> {
  return transport.call<PendingExtensionInstall | null>("browser_extension_install_crx")
}

/**
 * Rust shows a folder picker; `null` when it was cancelled. On confirm the
 * directory is copied into the store, never referenced in place.
 */
export function pickUnpackedExtension(): Promise<PendingExtensionInstall | null> {
  return transport.call<PendingExtensionInstall | null>("browser_extension_install_unpacked")
}

/** Install a pending package after the user confirmed its permissions. */
export function confirmExtensionInstall(pendingId: string): Promise<BrowserExtension> {
  return transport.call<BrowserExtension>("browser_extension_install_confirm", { pendingId })
}

/** Drop a pending package the user declined. */
export function cancelExtensionInstall(pendingId: string): Promise<void> {
  return transport.call<void>("browser_extension_install_cancel", { pendingId })
}

export function setExtensionEnabled(id: string, enabled: boolean): Promise<BrowserExtension> {
  return transport.call<BrowserExtension>("browser_extension_set_enabled", { id, enabled })
}

export function removeExtension(id: string): Promise<void> {
  return transport.call<void>("browser_extension_remove", { id })
}

export function checkExtensionUpdates(): Promise<BrowserExtensionUpdate[]> {
  return transport.call<BrowserExtensionUpdate[]>("browser_extensions_check_updates")
}

export function updateExtension(id: string): Promise<BrowserExtension> {
  return transport.call<BrowserExtension>("browser_extension_update", { id })
}
