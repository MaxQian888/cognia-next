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
import type { PairedDeviceRow } from "@/types/mobile/paired-device"
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
import { isWanBlocked, isWanDormant } from "@/lib/signaling/wan-dormancy"
import { getWanWakeOverrides, subscribeWanWakeOverrides } from "@/lib/signaling/wan-wake-overrides"
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
  /**
   * Test injection of the paired-device reader (defaults to Dexie
   * `listPairedDevices`).
   */
  listPairedDevicesOverride?: () => Promise<PairedDeviceRow[]>
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

  const readPairedDevices = options.listPairedDevicesOverride ?? listPairedDevices

  // The last rows Dexie handed us, kept because the device push now has TWO
  // triggers. A `pairedDevices` mutation is one. The owner waking a dormant
  // device is the other, and that one carries no rows of its own.
  let latestRows: PairedDeviceRow[] = []
  // Whether `latestRows` is an answer or just its initial value. `[]` means
  // "every device is ineligible" to the hub, which cancels every client it
  // holds, including ones `refresh_installed_hub` spawned from the Rust
  // registration store without the renderer's involvement. A wake fires this
  // push without carrying rows, so the wake path must not be able to send that
  // list before Dexie has answered, or after the read failed and left it empty.
  let rowsKnown = false

  const acceptRows = (rows: PairedDeviceRow[]): void => {
    latestRows = rows
    rowsKnown = true
    pushDevices()
  }

  const pushDevices = (): void => {
    if (!rowsKnown) return
    void transport
      .call<void>("companion_signaling_sync_devices", {
        devices: selectSignalingDevices(latestRows, {
          // Read per push rather than captured: dormancy is a function of the
          // clock, and a controller installed at boot outlives any `now` taken
          // there.
          now: Date.now(),
          wokenDeviceIds: getWanWakeOverrides(),
        }),
      })
      .catch((err) => {
        console.warn("companion_signaling_sync_devices failed", err)
      })
  }

  // `Dexie.liveQuery`, not a named `liveQuery` import: dexie's CJS build makes
  // `liveQuery` non-enumerable, so SWC's wildcard interop drops it the moment a
  // module also imports the `Dexie` default. See `lib/db/outbound-jobs.ts`.
  // Initial deterministic push, for the same reason the settings read below is
  // one: `liveQuery` does not emit without a real IndexedDB behind it, so the
  // first device list would otherwise depend on a mutation happening. The hub
  // diffs, so an identical follow-up from the subscription is a no-op.
  void readPairedDevices()
    .then(acceptRows)
    .catch((err) => {
      console.warn("desktop-signaling-controller: initial paired-device read failed", err)
    })

  const devicesSub: Subscription = Dexie.liveQuery(() => readPairedDevices()).subscribe({
    next: acceptRows,
    error: (err) => {
      console.warn("desktop-signaling-controller: pairedDevices query error", err)
    },
  })

  // A wake is the only path that spawns a client for a dormant device.
  // `SignalingHub::reconnect_device` cannot, because it looks the device up in
  // `pending_devices`, which is the last list this push produced, so a device
  // the filter dropped is unknown to it. Re-pushing is what makes it known.
  const unsubscribeWake = subscribeWanWakeOverrides(pushDevices)

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
  // Serialized form of the last patch the hub actually accepted. The settings
  // `liveQuery` below watches ONE Dexie row (the `AppSettings` singleton), so
  // it refires for every field any of the ~169 `saveSettings` call sites
  // touches — and `saveSettings` bumps `updatedAt` even when the value is
  // unchanged. Pushing regardless made the hub tear down one WSS per paired
  // device and re-run every handshake on, say, a theme change. The hub guards
  // this too; deduping here also saves the IPC and the keyring reads.
  let lastPushedPatch: string | null = null

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
    // `buildSignalingConfigPatch` and `normalizeServers` build fixed-key object
    // literals, so serialization is stable for equal inputs.
    const serialized = JSON.stringify(patch)
    if (serialized === lastPushedPatch) return
    await transport.call<void>("companion_signaling_configure", { patch })
    // Recorded only after the call resolves: a failed push leaves the hub on
    // the old configuration, and skipping the retry would strand it there. The
    // generation re-check keeps a slow push from overwriting a newer one.
    if (generation === configurationGeneration) lastPushedPatch = serialized
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
    unsubscribeWake()
    providerGeneration += 1
    configurationGeneration += 1
    lastPushedPatch = null
    provisioner?.stop()
    publishProvisionedTurnServers([])
  }
}

export interface SelectSignalingDevicesOptions {
  /**
   * The clock the dormancy rule is measured against. Injected so the whole
   * decision is a pure function of its inputs and the 30-day boundary is
   * testable without simulating a month.
   */
  now?: number
  /**
   * Device ids the owner explicitly woke, from
   * `lib/signaling/wan-wake-overrides.ts`. A woken device is exempt from the
   * dormancy rule and from nothing else, so waking a revoked or unprovisioned
   * device still yields no connection.
   */
  wokenDeviceIds?: ReadonlySet<string>
}

/**
 * Devices that should hold a live signaling client, in the wire shape the Rust
 * hub's `sync_devices` expects. Exported for unit tests.
 *
 * Every returned device costs one permanent WSS connection to the rendezvous
 * (the hub runs one client task per entry, and the Cloudflare deployment routes
 * each socket to a per-room Durable Object, so they cannot be multiplexed), so
 * this filter is the only thing standing between the paired-device list and the
 * connection count.
 *
 * Four reasons a paired device is left out, and they are not interchangeable:
 *
 *  * **Not provisioned.** No `rendezvousId`, no v2 room descriptor, or no
 *    host key reference. The device was paired before WebRTC landed, so there
 *    is no room to join.
 *  * **Revoked.** Gone.
 *  * **Paused.** Pausing adds the device to the Rust deny-list, so its JWT is
 *    refused and nothing arriving over its DataChannel can be served. Every
 *    other consumer already reads the two together
 *    (`lib/terminal/collaboration/roster.ts`,
 *    `lib/workflow/nodes/actions/mobile.ts`,
 *    `lib/workflow/runtime/capability-preflight.ts`) and this one did not, so a
 *    paused device kept a WAN socket open that could never do any work.
 *  * **Dormant.** Silent for 30 days (`lib/signaling/wan-dormancy.ts`). This is
 *    the only one of the four the owner can override from the console, and the
 *    only one that changes nothing about the device: the row, its pairing
 *    credentials and its grants all stay exactly as they were, and the device
 *    reconnects by itself the moment it is woken or makes one authenticated
 *    request.
 *
 * Dormancy is re-evaluated per push, and pushes happen on a `pairedDevices`
 * mutation or a wake. There is no timer, so a device that crosses the 30-day
 * line while the app sits open keeps its socket until the next write. That is
 * the harmless direction: the cost of one extra socket for a while, rather than
 * a connection dropped out from under a device the owner is watching.
 */
export function selectSignalingDevices(
  rows: PairedDeviceRow[],
  options: SelectSignalingDevicesOptions = {}
): DeviceRegistration[] {
  const now = options.now ?? Date.now()
  const woken = options.wokenDeviceIds
  return rows
    .filter(
      (r) =>
        !isWanBlocked(r) &&
        typeof r.rendezvousId === "string" &&
        r.signalingRoomDescriptor?.v === 2 &&
        typeof r.signalingKeyRef === "string" &&
        (woken?.has(r.deviceId) === true || !isWanDormant(r, now))
    )
    .map((r) => ({
      deviceId: r.deviceId,
      rendezvousId: r.rendezvousId!,
      roomDescriptor: r.signalingRoomDescriptor!,
      signalingKeyRef: r.signalingKeyRef!,
    }))
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
