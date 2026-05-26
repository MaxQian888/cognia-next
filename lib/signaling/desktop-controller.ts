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

// Import `transport` from the leaf module directly so we don't pull
// `@/lib/tauri` (the barrel) into our import graph. The barrel re-exports
// `transport` via `export { transport }`, which Jest's CJS compilation
// turns into a live getter. When `jest.mock("@/lib/tauri", () => ({
// ...jest.requireActual("@/lib/tauri") }))` is used in a sibling test
// the spread invokes that getter while the cycle
//   lib/tauri.ts → transport-instance → transport-companion → transport-rtc
//     → lib/signaling/index.ts → lib/signaling/desktop-controller.ts
// is still mid-evaluation, tripping a TDZ on the underlying
// `_transportinstance` binding. Importing the leaf bypasses the barrel
// getter entirely.
import { transport } from "@/lib/tauri/transport-instance"

function isTauriRenderer(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window
}
import { listPairedDevices } from "@/lib/db/paired-devices"
import { getSettings } from "@/lib/db/settings"
import { resolveTurnServerCredentials } from "@/lib/credentials/turn-credentials"
// Leaf `types` module (constants only) — avoids the `@/lib/signaling` barrel
// and its TDZ cycle described above.
import { DEFAULT_SIGNALING_URL } from "@/lib/signaling/types"

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
  const isDesktopTauri = options.isTauriOverride ?? isTauriRenderer()
  if (!isDesktopTauri) {
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
      // Resolve any `"kr:<keyId>"` sentinels in turnServers into real
      // credentials by reading from the OS keyring. The Rust hub
      // expects plaintext username + credential — the keyring lookup
      // is the only place we ever hold the secret in renderer memory.
      void (async () => {
        const turn = settings.turnServers
          ? await resolveTurnServerCredentials(settings.turnServers)
          : []
        const patch: SignalingConfigPatch = {
          enabled: settings.webrtcEnabled ?? true,
          signalingUrl: settings.signalingUrl ?? DEFAULT_SIGNALING_URL,
          iceServers: normalizeServers(settings.iceServers) ?? DEFAULT_STUN,
          turnServers: normalizeServers(turn) ?? [],
        }
        await transport.call<void>("companion_signaling_configure", { patch })
      })().catch((err) => {
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
