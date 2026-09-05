// Stable per-install device identity for backup/sync provenance.
//
// `getDeviceId()` is generate-once, mirroring `lib/data/backup-key.ts`:
//   • Tauri → @tauri-apps/plugin-store, file `cognia-device.json`,
//             key `device.id.v1`.
//   • Web/Capacitor → localStorage, key `cognia-device-id-v1`.
//
// The id + a FRIENDLY label (never the raw `navigator.userAgent` — the label
// lands cleartext in the WebDAV envelope manifest) annotate every backup
// snapshot so the restore dialog and history can show which device produced
// it (see `BackupManifestV3.device`).

import { isTauri } from "@/lib/tauri"
import { getDevicePlatform } from "@/components/connectivity/pair/pair-helpers"

const WEB_DEVICE_ID_STORAGE = "cognia-device-id-v1"
const DESKTOP_STORE_FILE = "cognia-device.json"
const DESKTOP_STORE_KEY = "device.id.v1"

export interface DeviceMetadata {
  /** Stable per-install UUID. */
  id: string
  /** Friendly, generic label ("Windows desktop", "iOS device", …). */
  label?: string
  /** Capacitor platform / "desktop" / "web". */
  platform?: string
}

function generateId(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID()
  }
  // Crypto-less fallback (old WebViews) — still unique enough for provenance.
  return `dev-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`
}

async function getDesktopDeviceId(): Promise<string | null> {
  try {
    const { LazyStore } = await import("@tauri-apps/plugin-store")
    const store = new LazyStore(DESKTOP_STORE_FILE)
    const existing = await store.get<string>(DESKTOP_STORE_KEY)
    if (existing && typeof existing === "string") return existing
    const generated = generateId()
    await store.set(DESKTOP_STORE_KEY, generated)
    await store.save()
    return generated
  } catch {
    // Plugin unavailable — caller falls back to web storage.
    return null
  }
}

function getWebDeviceId(): string {
  const existing =
    typeof localStorage !== "undefined" ? localStorage.getItem(WEB_DEVICE_ID_STORAGE) : null
  if (existing) return existing
  const generated = generateId()
  if (typeof localStorage !== "undefined") {
    localStorage.setItem(WEB_DEVICE_ID_STORAGE, generated)
  }
  return generated
}

/**
 * Stable per-install device id, generated on first call. Returns null on the
 * server (SSR), where neither localStorage nor Tauri is available.
 */
export async function getDeviceId(): Promise<string | null> {
  if (typeof window === "undefined") return null
  if (isTauri()) {
    const id = await getDesktopDeviceId()
    if (id) return id
  }
  return getWebDeviceId()
}

/**
 * Generic, privacy-preserving label. Deliberately NOT `navigator.userAgent`
 * (which is verbose and identifying) — the label is stored cleartext in the
 * snapshot envelope's manifest.
 */
export function getFriendlyDeviceLabel(): string {
  if (typeof window === "undefined") return "Unknown device"
  const platform = getDevicePlatform()
  if (platform === "ios") return "iOS device"
  if (platform === "android") return "Android device"
  const ua = typeof navigator !== "undefined" ? (navigator.userAgent ?? "") : ""
  const os = /Windows/i.test(ua)
    ? "Windows"
    : /Mac OS|Macintosh/i.test(ua)
      ? "macOS"
      : /Linux/i.test(ua)
        ? "Linux"
        : null
  if (isTauri()) return os ? `${os} desktop` : "Desktop"
  return os ? `${os} browser` : "Web browser"
}

/** Normalized platform string for the manifest: ios / android / desktop / web. */
export function getDevicePlatformKind(): string {
  if (typeof window === "undefined") return "unknown"
  if (isTauri()) return "desktop"
  return getDevicePlatform()
}

/** Full provenance blob for `BackupManifestV3.device`; null on SSR. */
export async function getDeviceMetadata(): Promise<DeviceMetadata | null> {
  const id = await getDeviceId()
  if (!id) return null
  return { id, label: getFriendlyDeviceLabel(), platform: getDevicePlatformKind() }
}

export const __TESTING__ = { WEB_DEVICE_ID_STORAGE, DESKTOP_STORE_FILE, DESKTOP_STORE_KEY }
