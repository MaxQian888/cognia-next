// Auto-key fallback for the v3 encrypted backup format. The user can always
// type a custom passphrase; this module provides the "encrypt with the
// device's stored key" fast path so users don't need to manage passphrases.
//
// Storage:
//   • Tauri  → @tauri-apps/plugin-store, file `cognia-backup-key.json`,
//             key `backup.encryption.key.v1`.
//   • Web    → localStorage, key `cognia-backup-encryption-key-v1`.

import { nanoid } from "nanoid"
import { isHeadlessHost } from "@/lib/platform/detect"
import { isTauri, transport } from "@/lib/tauri"

const WEB_BACKUP_KEY_STORAGE = "cognia-backup-encryption-key-v1"
const DESKTOP_STORE_FILE = "cognia-backup-key.json"
const DESKTOP_STORE_KEY = "backup.encryption.key.v1"
const SERVER_SECRET_NAMESPACE = "backup"
const SERVER_SECRET_KEY = "encryption.key.v1"

function generateKeyMaterial(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return `${globalThis.crypto.randomUUID()}-${nanoid(20)}`
  }
  return nanoid(48)
}

async function getDesktopBackupKey(): Promise<string | null> {
  try {
    const { LazyStore } = await import("@tauri-apps/plugin-store")
    const store = new LazyStore(DESKTOP_STORE_FILE)
    const existing = await store.get<string>(DESKTOP_STORE_KEY)
    if (existing && typeof existing === "string") {
      return existing
    }
    const generated = generateKeyMaterial()
    await store.set(DESKTOP_STORE_KEY, generated)
    await store.save()
    return generated
  } catch {
    // Plugin not available — caller will fall back to web behavior or null.
    return null
  }
}

function getWebBackupKey(): string {
  const existing =
    typeof localStorage !== "undefined" ? localStorage.getItem(WEB_BACKUP_KEY_STORAGE) : null
  if (existing) return existing

  const generated = generateKeyMaterial()
  if (typeof localStorage !== "undefined") {
    localStorage.setItem(WEB_BACKUP_KEY_STORAGE, generated)
  }
  return generated
}

async function getHeadlessBackupKey(): Promise<string> {
  const input = { namespace: SERVER_SECRET_NAMESPACE, key: SERVER_SECRET_KEY }
  const existing = await transport.call<string | null>("secret_store_get", { input })
  if (existing) return existing
  const generated = generateKeyMaterial()
  await transport.call("secret_store_set", { input: { ...input, value: generated } })
  return generated
}

/**
 * Returns the device-stored auto-key, generating one on first call. Returns
 * null on the server (SSR), where neither localStorage nor Tauri is available.
 */
export async function getDefaultBackupPassphrase(): Promise<string | null> {
  if (isHeadlessHost()) return getHeadlessBackupKey()
  if (typeof window === "undefined") return null
  if (isTauri()) {
    const key = await getDesktopBackupKey()
    if (key) return key
    // Tauri runtime present but plugin unavailable — fall through to web fallback
    // so the user isn't left without an auto-key entirely.
  }
  return getWebBackupKey()
}

/**
 * Replace the auto-key with a fresh value. Useful when the user wants to
 * "rotate" their backup encryption — old files become unreadable with the
 * new key (custom-passphrase files are unaffected).
 */
export async function rotateBackupKey(): Promise<string | null> {
  const generated = generateKeyMaterial()
  if (isHeadlessHost()) {
    await transport.call("secret_store_set", {
      input: {
        namespace: SERVER_SECRET_NAMESPACE,
        key: SERVER_SECRET_KEY,
        value: generated,
      },
    })
    return generated
  }
  if (typeof window === "undefined") return null
  if (isTauri()) {
    try {
      const { LazyStore } = await import("@tauri-apps/plugin-store")
      const store = new LazyStore(DESKTOP_STORE_FILE)
      await store.set(DESKTOP_STORE_KEY, generated)
      await store.save()
      return generated
    } catch {
      // Fall through to web behavior.
    }
  }
  if (typeof localStorage !== "undefined") {
    localStorage.setItem(WEB_BACKUP_KEY_STORAGE, generated)
  }
  return generated
}

/** Wipe the stored auto-key. Next call to `getDefaultBackupPassphrase` regenerates. */
export async function clearBackupKey(): Promise<void> {
  if (isHeadlessHost()) {
    await transport.call("secret_store_delete", {
      input: { namespace: SERVER_SECRET_NAMESPACE, key: SERVER_SECRET_KEY },
    })
    return
  }
  if (typeof window === "undefined") return
  if (isTauri()) {
    try {
      const { LazyStore } = await import("@tauri-apps/plugin-store")
      const store = new LazyStore(DESKTOP_STORE_FILE)
      await store.delete(DESKTOP_STORE_KEY)
      await store.save()
      return
    } catch {
      // Fall through.
    }
  }
  if (typeof localStorage !== "undefined") {
    localStorage.removeItem(WEB_BACKUP_KEY_STORAGE)
  }
}

export const __TESTING__ = {
  WEB_BACKUP_KEY_STORAGE,
  DESKTOP_STORE_FILE,
  DESKTOP_STORE_KEY,
  SERVER_SECRET_NAMESPACE,
  SERVER_SECRET_KEY,
}
