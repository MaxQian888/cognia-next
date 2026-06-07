// In-memory dirty marker for the subscription vaults. The transport layer
// calls `markSubscriptionVaultChanged()` after every successful vault
// mutation; the marker debounces into an unattended WebDAV upload and feeds
// the auto-upload dirty check.
//
// Deliberately import-light (no static dependency on the sync pipeline) so
// the transport layer can depend on it without a cycle:
//   transport → change-tracker        (static)
//   change-tracker → subscription-sync (dynamic, inside the debounce callback)
//   subscription-sync → vault-snapshot → transport (static)

/** Debounce window after a vault mutation before the auto-upload fires. */
export const VAULT_CHANGE_DEBOUNCE_MS = 30 * 1000

let lastVaultChangeAtMs: number | null = null
let debounceTimer: ReturnType<typeof setTimeout> | null = null

/**
 * Record that a vault-mutating subscription command ran; schedules a
 * debounced unattended upload. Never throws.
 */
export function markSubscriptionVaultChanged(nowMs: number = Date.now()): void {
  lastVaultChangeAtMs = nowMs
  if (debounceTimer) clearTimeout(debounceTimer)
  debounceTimer = setTimeout(() => {
    debounceTimer = null
    // Dynamic import keeps this module cycle-free (see header).
    void import("./subscription-sync")
      .then((m) => m.maybeAutoUploadSubscription())
      .catch(() => undefined)
  }, VAULT_CHANGE_DEBOUNCE_MS)
  // Don't keep the process alive just for a pending auto-upload (Node tests,
  // sidecar-ish contexts). No-op in browsers where unref doesn't exist.
  ;(debounceTimer as { unref?: () => void }).unref?.()
}

export function getLastVaultChangeAtMs(): number | null {
  return lastVaultChangeAtMs
}

/** Test-only reset. */
export function __resetVaultChangeTrackerForTesting(): void {
  lastVaultChangeAtMs = null
  if (debounceTimer) clearTimeout(debounceTimer)
  debounceTimer = null
}
