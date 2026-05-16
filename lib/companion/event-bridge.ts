/**
 * Rust → Dexie event bridge for the mobile-companion subsystem.
 *
 * The Rust pair handler emits `companion://device-paired` after a successful
 * pair-JWT exchange (`src-tauri/src/companion_api/auth.rs`); the JWT verifier
 * middleware emits `companion://device-seen` on every authenticated request
 * (`src-tauri/src/companion_api/middleware.rs`). This module subscribes to
 * both via the shared `transport` and persists the payloads to Dexie's
 * `pairedDevices` table so the M2.8 settings UI sees real-time updates.
 *
 * Mounted once at app startup by `CompanionEventBridgeProvider`.
 */

import { addPairedDevice, touchPairedDevice } from "@/lib/db/paired-devices"
import { transport } from "@/lib/tauri"
import type { DevicePlatform } from "@/types/mobile/paired-device"

// ---------------------------------------------------------------------------
// Event payloads — mirror the JSON shape emitted by the Rust handlers.
// ---------------------------------------------------------------------------

interface DevicePairedPayload {
  device_id: string
  label: string
  platform: string
  pubkey: string
  paired_at_ms: number
  app_version: string
  /** ADR-0021: optional for legacy desktop servers that predate WebRTC. */
  rendezvous_id?: string
  /** ADR-0021: 32-byte HMAC key, URL-safe base64 (unpadded). */
  rendezvous_secret?: string
}

interface DeviceSeenPayload {
  device_id: string
  seen_at_ms: number
}

const KNOWN_PLATFORMS: ReadonlySet<DevicePlatform> = new Set(["ios", "android", "web", "unknown"])

function normalizePlatform(value: string): DevicePlatform {
  return KNOWN_PLATFORMS.has(value as DevicePlatform) ? (value as DevicePlatform) : "unknown"
}

// ---------------------------------------------------------------------------
// Public installer
// ---------------------------------------------------------------------------

/**
 * Subscribe to the two companion events and persist them to Dexie. Returns a
 * detach function that removes both listeners — call it on unmount or hot
 * reload to avoid double-handling.
 *
 * Failures inside the handlers are swallowed: the Dexie write is best-effort
 * (the verifier middleware already runs on a `tokio::spawn`, so a missed
 * persistence is a UI lag — never a request failure).
 */
export function installCompanionEventBridge(): () => void {
  const unsubPaired = transport.subscribe<DevicePairedPayload>(
    "companion://device-paired",
    (payload) => {
      void handleDevicePaired(payload)
    }
  )

  const unsubSeen = transport.subscribe<DeviceSeenPayload>("companion://device-seen", (payload) => {
    void handleDeviceSeen(payload)
  })

  return () => {
    unsubPaired()
    unsubSeen()
  }
}

async function handleDevicePaired(payload: DevicePairedPayload): Promise<void> {
  try {
    await addPairedDevice({
      deviceId: payload.device_id,
      label: payload.label,
      platform: normalizePlatform(payload.platform),
      pubkey: payload.pubkey,
      appVersion: payload.app_version,
      rendezvousId: payload.rendezvous_id,
      rendezvousSecret: payload.rendezvous_secret,
      nowMs: payload.paired_at_ms,
    })
  } catch (err) {
    // Dexie unavailable / closed during shutdown — non-fatal.
    console.warn("companion event-bridge: addPairedDevice failed", err)
  }
}

async function handleDeviceSeen(payload: DeviceSeenPayload): Promise<void> {
  try {
    await touchPairedDevice(payload.device_id, payload.seen_at_ms)
  } catch (err) {
    console.warn("companion event-bridge: touchPairedDevice failed", err)
  }
}
