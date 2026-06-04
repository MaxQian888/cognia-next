// In-memory cache for the zero-knowledge WebDAV sync passphrase, plus the
// opt-in keyring persistence layer.
//
// Default behavior is unchanged from the original design: the passphrase
// lives only for the current session, set once the user unlocks, and
// scheduled/unattended uploads only fire after an in-session unlock (the
// executor records a "passphrase locked" failure rather than silently
// falling back to the device auto-key, which the other device could not
// decrypt).
//
// NEW (opt-in): when `webdavSync.rememberPassphrase === true` the proven
// passphrase is ALSO persisted to the OS keyring (`WEBDAV_PASSPHRASE_REF`)
// and re-hydrated into this cache on boot by `loadPersistedSyncPassphrase()`
// — that's what makes fully unattended automation possible. Turning the
// toggle off (or calling `forgetSyncPassphrase`) wipes the keyring copy.
//
// Module-level singleton: tests must call `clearSyncPassphrase()` in afterEach.

import { getSettings } from "@/lib/db/settings"

import {
  clearStoredSyncPassphrase,
  getStoredSyncPassphrase,
  setStoredSyncPassphrase,
} from "./config"

let cached: string | null = null

export function setSyncPassphrase(passphrase: string | null): void {
  cached = passphrase && passphrase.length > 0 ? passphrase : null
}

export function getSyncPassphrase(): string | null {
  return cached
}

export function hasSyncPassphrase(): boolean {
  return cached !== null
}

export function clearSyncPassphrase(): void {
  cached = null
}

/**
 * Persist a proven passphrase to the keyring — but ONLY when the user opted
 * into `webdavSync.rememberPassphrase`. Callers invoke this after a
 * successful encrypt/decrypt proved the passphrase correct (sync-now,
 * restore). Best-effort: a keyring failure never fails the parent operation.
 */
export async function persistSyncPassphrase(passphrase: string): Promise<void> {
  if (!passphrase) return
  try {
    const settings = await getSettings()
    if (settings.webdavSync?.rememberPassphrase !== true) return
    await setStoredSyncPassphrase(passphrase)
  } catch {
    // Keyring unavailable — the session cache still works.
  }
}

/**
 * Boot hydration: when the user opted in and a passphrase is stored, load it
 * into the session cache so the scheduler and the remote-newer check can run
 * without an interactive unlock. Returns true when the cache was hydrated.
 * Never throws (keyring may be locked/unavailable, web auto-key may not be
 * injected yet) — automation simply stays locked in that case.
 */
export async function loadPersistedSyncPassphrase(): Promise<boolean> {
  if (cached !== null) return true
  try {
    const settings = await getSettings()
    if (settings.webdavSync?.rememberPassphrase !== true) return false
    const stored = await getStoredSyncPassphrase()
    if (!stored) return false
    cached = stored
    return true
  } catch {
    return false
  }
}

/** Wipe BOTH the session cache and the keyring copy (toggle-off, sign-out). */
export async function forgetSyncPassphrase(): Promise<void> {
  cached = null
  try {
    await clearStoredSyncPassphrase()
  } catch {
    // Best-effort.
  }
}
