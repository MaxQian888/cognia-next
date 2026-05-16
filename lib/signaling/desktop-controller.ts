"use client"

/**
 * Desktop-side glue that keeps the Rust `SignalingHub` in sync with the
 * renderer's Dexie + AppSettings state. ADR-0021.
 *
 * Responsibilities:
 *
 * 1. **Hydrate at boot.** After Dexie is open, push the current list of
 *    paired devices (those with a `rendezvousId` + `rendezvousSecret`)
 *    plus the current signaling URL / ICE / TURN configuration to the
 *    Rust hub via Tauri commands.
 * 2. **Subscribe to changes.** Dexie's `liveQuery` fires on every
 *    `pairedDevices` mutation; AppSettings mutations are picked up via
 *    a parallel `liveQuery`. Both feed back into `sync_devices` /
 *    `configure`.
 * 3. **Idempotent shutdown.** The returned uninstaller cancels both
 *    queries — the hub side is a no-op when re-synced with the same
 *    set.
 *
 * This module is a no-op on web / Capacitor — only the Tauri renderer
 * has access to the Rust hub. The mobile side runs its mirror in
 * `lib/tauri/transport-rtc.ts`.
 */

import { liveQuery, type Subscription } from "dexie"

import { isTauri, transport } from "@/lib/tauri"
import { listPairedDevices } from "@/lib/db/paired-devices"
import { getSettings } from "@/lib/db/settings"

interface DeviceRegistration {
  deviceId: string
  rendezvousId: string
  rendezvousSecret: string
}

interface IceServerSpec {
  urls: string[]
  username?: string
  credential?: string
}

interface SignalingConfigPatch {
  enabled: boolean
  signalingUrl: string
  iceServers: IceServerSpec[]
  turnServers: IceServerSpec[]
}

const DEFAULT_SIGNALING_URL = "wss://signaling.cognia.app/v1/signaling"
const DEFAULT_STUN: IceServerSpec[] = [
  { urls: ["stun:stun.l.google.com:19302"] },
  { urls: ["stun:stun.cloudflare.com:3478"] },
]

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface DesktopSignalingControllerOptions {
  /** Override the Tauri-detection (test injection). */
  isTauriOverride?: boolean
}

/**
 * Start the controller. Returns an uninstall function that cancels both
 * live-queries. Idempotent: subsequent calls without prior uninstall
 * still install new subscriptions; the caller is responsible for cleanup.
 */
export function installDesktopSignalingController(
  options: DesktopSignalingControllerOptions = {}
): () => void {
  const tauri = options.isTauriOverride ?? isTauri()
  if (!tauri) {
    return () => {
      // No-op on web / Capacitor.
    }
  }

  const devicesSub: Subscription = liveQuery(() => listPairedDevices()).subscribe({
    next: (rows) => {
      const eligible = rows.filter(
        (r) =>
          !r.revokedAt &&
          typeof r.rendezvousId === "string" &&
          typeof r.rendezvousSecret === "string"
      )
      const payload: DeviceRegistration[] = eligible.map((r) => ({
        deviceId: r.deviceId,
        rendezvousId: r.rendezvousId!,
        rendezvousSecret: r.rendezvousSecret!,
      }))
      void transport
        .call<void>("companion_signaling_sync_devices", { devices: payload })
        .catch((err) => {
          console.warn("companion_signaling_sync_devices failed", err)
        })
    },
    error: (err) => {
      console.warn("desktop-signaling-controller: pairedDevices query error", err)
    },
  })

  const settingsSub: Subscription = liveQuery(() => getSettings()).subscribe({
    next: (settings) => {
      const patch: SignalingConfigPatch = {
        enabled: settings.webrtcEnabled ?? true,
        signalingUrl: settings.signalingUrl ?? DEFAULT_SIGNALING_URL,
        iceServers: normalizeServers(settings.iceServers) ?? DEFAULT_STUN,
        turnServers: normalizeServers(settings.turnServers) ?? [],
      }
      void transport.call<void>("companion_signaling_configure", { patch }).catch((err) => {
        console.warn("companion_signaling_configure failed", err)
      })
    },
    error: (err) => {
      console.warn("desktop-signaling-controller: settings query error", err)
    },
  })

  return () => {
    devicesSub.unsubscribe()
    settingsSub.unsubscribe()
  }
}

// ---------------------------------------------------------------------------
// Helpers — exported for tests.
// ---------------------------------------------------------------------------

export function normalizeServers(servers: RTCIceServer[] | undefined): IceServerSpec[] | undefined {
  if (!servers) return undefined
  return servers.map((s) => {
    const urls = Array.isArray(s.urls) ? s.urls : [s.urls]
    return {
      urls,
      username: s.username,
      credential:
        typeof s.credential === "string"
          ? s.credential
          : s.credential != null
            ? String(s.credential)
            : undefined,
    }
  })
}
