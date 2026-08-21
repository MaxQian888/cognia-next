"use client"

/**
 * Desktop-side glue that keeps the Rust `SignalingHub` in sync with the
 * renderer's Dexie + AppSettings state. ADR-0021.
 *
 * Responsibilities:
 *
 * 1. **Hydrate at boot.** After Dexie is open, push the current list of
 *    paired devices (those with a room descriptor + host key reference)
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

import Dexie, { type Subscription } from "dexie"

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
import { isTauri } from "@/lib/platform/detect"
import { transport } from "@/lib/tauri/transport-instance"

function isTauriRenderer(): boolean {
  return isTauri()
}
import { listPairedDevices } from "@/lib/db/paired-devices"
import { getSettings } from "@/lib/db/settings"
import { resolveTurnServerCredentials } from "@/lib/credentials/turn-credentials"
import {
  startTurnProvisioner,
  type ProvisionerHandle,
} from "@/lib/credentials/turn-provisioning-cache"
import { publishProvisionedTurnServers } from "@/lib/signaling/provisioned-turn-state"
// Leaf `types` module (constants only) — avoids the `@/lib/signaling` barrel
// and its TDZ cycle described above.
import { DEFAULT_SIGNALING_URL } from "@/lib/signaling/types"
import type { RoomDescriptor } from "@/lib/signaling/crypto"
import type { AppSettings } from "@cognia/agent-config-types"

interface DeviceRegistration {
  deviceId: string
  rendezvousId: string
  roomDescriptor: RoomDescriptor
  signalingKeyRef: string
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
  /** Test injection of the settings reader (defaults to Dexie `getSettings`). */
  getSettingsOverride?: () => Promise<AppSettings>
  /** Test injection of the TURN provisioner (defaults to `startTurnProvisioner`). */
  startTurnProvisionerOverride?: typeof startTurnProvisioner
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

  // `Dexie.liveQuery`, not a named `liveQuery` import: dexie's CJS build makes
  // `liveQuery` non-enumerable, so SWC's wildcard interop drops it the moment a
  // module also imports the `Dexie` default. See `lib/db/outbound-jobs.ts`.
  const devicesSub: Subscription = Dexie.liveQuery(() => listPairedDevices()).subscribe({
    next: (rows) => {
      const eligible = rows.filter(
        (r) =>
          !r.revokedAt &&
          typeof r.rendezvousId === "string" &&
          r.signalingRoomDescriptor?.v === 2 &&
          typeof r.signalingKeyRef === "string"
      )
      const payload: DeviceRegistration[] = eligible.map((r) => ({
        deviceId: r.deviceId,
        rendezvousId: r.rendezvousId!,
        roomDescriptor: r.signalingRoomDescriptor!,
        signalingKeyRef: r.signalingKeyRef!,
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

  const readSettings = options.getSettingsOverride ?? getSettings
  const startProvisioner = options.startTurnProvisionerOverride ?? startTurnProvisioner

  // ADR-0021 — automatic ephemeral-TURN provisioning, mirroring the mobile
  // controller. The desktop holds its OWN provider secret in its OS keyring
  // and mints independent ephemeral credentials (TURN allocations are
  // per-credential, so the peers don't share secrets).
  let provisioner: ProvisionerHandle | null = null
  let lastProviderKey: string | null = null
  let lastSettings: AppSettings | null = null
  let providerGeneration = 0
  let configurationGeneration = 0

  const pushConfigure = async (
    settings: AppSettings,
    providerServers: RTCIceServer[],
    generation: number
  ): Promise<void> => {
    // Resolve any `"kr:<keyId>"` sentinels in turnServers into real
    // credentials from the OS keyring before handing them to the Rust hub
    // (which expects plaintext username + credential).
    const turn = settings.turnServers
      ? await resolveTurnServerCredentials(settings.turnServers)
      : []
    if (generation !== configurationGeneration) return
    const patch = buildSignalingConfigPatch(settings, turn, providerServers)
    await transport.call<void>("companion_signaling_configure", { patch })
  }

  const manageProvisioner = (settings: AppSettings): void => {
    lastSettings = settings
    const tp = settings.turnProvider
    const key = tp && tp.kind !== "none" ? JSON.stringify(tp) : ""
    if (key === lastProviderKey) return
    lastProviderKey = key
    const generation = ++providerGeneration
    provisioner?.stop()
    provisioner = null
    publishProvisionedTurnServers([])
    if (key && tp) {
      provisioner = startProvisioner({
        provider: tp,
        onRefresh: (iceServers) => {
          if (generation !== providerGeneration || !lastSettings) return
          publishProvisionedTurnServers(iceServers)
          const configureGeneration = ++configurationGeneration
          void pushConfigure(lastSettings, iceServers, configureGeneration).catch((err) => {
            console.warn("desktop-signaling-controller: provisioner re-push failed", err)
          })
        },
      })
      const current = provisioner.current()
      if (current.length > 0) publishProvisionedTurnServers(current)
    }
  }

  const handleSettings = (settings: AppSettings): void => {
    manageProvisioner(settings)
    const generation = ++configurationGeneration
    void pushConfigure(settings, provisioner?.current() ?? [], generation).catch((err) => {
      console.warn("companion_signaling_configure failed", err)
    })
  }

  // Initial deterministic push (does not depend on the liveQuery first-fire,
  // which is unreliable under fake-indexeddb in tests).
  void readSettings()
    .then(handleSettings)
    .catch((err) => {
      console.warn("desktop-signaling-controller: initial settings read failed", err)
    })

  const settingsSub: Subscription = Dexie.liveQuery(() => readSettings()).subscribe({
    next: (settings) => {
      handleSettings(settings)
    },
    error: (err) => {
      console.warn("desktop-signaling-controller: settings query error", err)
    },
  })

  return () => {
    devicesSub.unsubscribe()
    settingsSub.unsubscribe()
    providerGeneration += 1
    configurationGeneration += 1
    provisioner?.stop()
    publishProvisionedTurnServers([])
  }
}

/**
 * Build the `SignalingConfigPatch` sent to the Rust hub. Static STUN goes in
 * `iceServers`; static (keyring-resolved) TURN plus any provider-provisioned
 * ephemeral relays are merged into `turnServers`. Exported for unit tests.
 */
export function buildSignalingConfigPatch(
  settings: AppSettings,
  resolvedTurn: RTCIceServer[],
  providerServers: RTCIceServer[]
): SignalingConfigPatch {
  return {
    enabled: settings.webrtcEnabled ?? true,
    signalingUrl: settings.signalingUrl ?? DEFAULT_SIGNALING_URL,
    iceServers: normalizeServers(settings.iceServers) ?? DEFAULT_STUN,
    turnServers: normalizeServers([...resolvedTurn, ...providerServers]) ?? [],
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
