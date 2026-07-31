/**
 * Web-standalone → cloud-companion detection (ADR-0059 C1).
 *
 * A plain browser build becomes a *cloud companion* when it has a
 * cognia-server to talk to. Two ways to have one:
 *
 * 1. **Build-time**: `NEXT_PUBLIC_COGNIA_SERVER_URL` — the self-host operator
 *    bakes their server URL into the web bundle (compose/k8s deployments
 *    serve the static export next to the server).
 * 2. **Runtime**: the user already paired in this browser — a
 *    `CompanionConfig` sits in localStorage (written by the /pair page).
 *
 * Pure leaf, synchronous on purpose: `pickTransport()` runs at module load,
 * so this must not await the async storage facade. It reads the same
 * localStorage key `LocalStorageCompanionStorage` owns.
 */

import { getActiveRuntimeTargetContext } from "@/lib/runtime/runtime-target-context"

// Mirrors CONFIG_KEY in lib/tauri/companion-storage.ts (asserted by test).
export const WEB_COMPANION_CONFIG_KEY = "cognia.companion.config.v1"
export const WEB_COMPANION_TARGET_BOOK_KEY = "cognia.companion.targets.v2"

/** Build-time server URL, normalized (no trailing slash); null when unset. */
export function buildTimeServerUrl(): string | null {
  const url = process.env.NEXT_PUBLIC_COGNIA_SERVER_URL
  if (!url || url.trim() === "") return null
  return url.trim().replace(/\/+$/, "")
}

/** Whether a paired CompanionConfig exists in this browser. */
export function hasStoredWebPairing(): boolean {
  if (typeof window === "undefined") return false
  try {
    const targetBookRaw = window.localStorage.getItem(WEB_COMPANION_TARGET_BOOK_KEY)
    if (targetBookRaw) {
      const targetBook = JSON.parse(targetBookRaw) as {
        version?: unknown
        targets?: Record<string, unknown>
      }
      if (targetBook.version === 2 && targetBook.targets) {
        const scope = getActiveRuntimeTargetContext()
        if (scope) {
          return Boolean(targetBook.targets[`${scope.accountId}:${scope.targetId}`])
        }
        if (Object.keys(targetBook.targets).length > 0) return true
      }
    }

    const raw = window.localStorage.getItem(WEB_COMPANION_CONFIG_KEY)
    if (!raw) return false
    const parsed = JSON.parse(raw) as {
      baseUrl?: unknown
      deviceJwt?: unknown
      deviceJwtEncrypted?: unknown
    }
    return (
      typeof parsed.baseUrl === "string" &&
      (typeof parsed.deviceJwt === "string" ||
        (typeof parsed.deviceJwtEncrypted === "object" && parsed.deviceJwtEncrypted !== null))
    )
  } catch {
    return false
  }
}

/**
 * Whether this web build should run the companion transport instead of the
 * stub. True in a plain browser (NOT Tauri/Capacitor — callers gate on that)
 * with either a configured server or an existing pairing.
 */
export function hasWebCompanionTarget(): boolean {
  return buildTimeServerUrl() !== null || hasStoredWebPairing()
}
