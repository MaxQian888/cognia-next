// In-memory cache for the subscription-vault sync passphrase, plus the
// opt-in keyring persistence layer. Mirrors `lib/webdav/passphrase-cache.ts`
// (same threat model, same `webdavSync.rememberPassphrase` opt-in toggle)
// but holds a SEPARATE secret under a separate keyring key — the data-backup
// passphrase and the subscription passphrase are independent.
//
// Module-level singleton: tests must call `clearSubscriptionSyncPassphrase()`
// in afterEach.

import { getSettings } from "@/lib/db/settings"
import { clearSecret, getSecret, setSecret, type KeyringRef } from "@/lib/keyring"

/** Opt-in persisted copy — same namespace as the WebDAV secrets. */
export const SUBSCRIPTION_SYNC_PASSPHRASE_REF: KeyringRef = {
  namespace: "webdav-sync",
  key: "subscription-passphrase",
}

let cached: string | null = null

export function setSubscriptionSyncPassphrase(passphrase: string | null): void {
  cached = passphrase && passphrase.length > 0 ? passphrase : null
}

export function getSubscriptionSyncPassphrase(): string | null {
  return cached
}

export function hasSubscriptionSyncPassphrase(): boolean {
  return cached !== null
}

export function clearSubscriptionSyncPassphrase(): void {
  cached = null
}

/**
 * Persist a proven passphrase to the keyring — but ONLY when the user opted
 * into `webdavSync.rememberPassphrase`. Called after a successful
 * encrypt/decrypt proved the passphrase correct. Best-effort: a keyring
 * failure never fails the parent operation.
 */
export async function persistSubscriptionSyncPassphrase(passphrase: string): Promise<void> {
  if (!passphrase) return
  try {
    const settings = await getSettings()
    if (settings.webdavSync?.rememberPassphrase !== true) return
    await setSecret(SUBSCRIPTION_SYNC_PASSPHRASE_REF, passphrase)
  } catch {
    // Keyring unavailable — the session cache still works.
  }
}

/**
 * Boot hydration: when the user opted in and a passphrase is stored, load it
 * into the session cache so unattended uploads can run. Returns true when
 * the cache holds a passphrase afterwards. Never throws.
 */
export async function loadPersistedSubscriptionSyncPassphrase(): Promise<boolean> {
  if (cached !== null) return true
  try {
    const settings = await getSettings()
    if (settings.webdavSync?.rememberPassphrase !== true) return false
    const stored = await getSecret(SUBSCRIPTION_SYNC_PASSPHRASE_REF)
    if (!stored) return false
    cached = stored
    return true
  } catch {
    return false
  }
}

/** Wipe BOTH the session cache and the keyring copy (toggle-off, sign-out). */
export async function forgetSubscriptionSyncPassphrase(): Promise<void> {
  cached = null
  try {
    await clearSecret(SUBSCRIPTION_SYNC_PASSPHRASE_REF)
  } catch {
    // Best-effort.
  }
}
