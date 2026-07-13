"use client"

/**
 * Mobile-side glue that opts the live `CompanionTransport` into the
 * WebRTC tier whenever:
 *
 *   - the user has not disabled it (AppSettings.webrtcEnabled),
 *   - the paired device has a rendezvous tuple (post-ADR-0021 pair),
 *   - and an `signalingUrl` is configured.
 *
 * Runs only on Capacitor; the Tauri desktop is the server peer (driven
 * by `desktop-controller.ts`) and the plain browser shell has no
 * CompanionTransport. The transport itself handles fallback to HTTPS+WS
 * when the WebRTC negotiation fails, so this controller can be safe to
 * invoke unconditionally on platform detection.
 *
 * ADR-0021.
 */

import { liveQuery, type Subscription } from "dexie"

import { subscribeResume } from "@/lib/capacitor/app"
import { subscribe as subscribeNetwork } from "@/lib/capacitor/network"
import { isCapacitor, transport } from "@/lib/tauri"
import {
  CompanionTransport,
  hydrateCompanionConfig,
  loadCompanionConfig,
  saveCompanionConfig,
} from "@/lib/tauri/transport-companion"
import { resolveLanBaseUrl } from "@/lib/connectivity/lan-resolver"
import { getSettings } from "@/lib/db/settings"
import { resolveTurnServerCredentials } from "@/lib/credentials/turn-credentials"
import {
  startTurnProvisioner,
  type ProvisionerHandle,
} from "@/lib/credentials/turn-provisioning-cache"
import { DEFAULT_SIGNALING_URL } from "@/lib/signaling/types"
import type { AppSettings } from "@cognia/agent-config-types"

const DEFAULT_STUN: RTCIceServer[] = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun.cloudflare.com:3478" },
]

/**
 * Minimum spacing between two automatic WebRTC re-upgrade attempts driven by
 * network-reconnect / app-resume events. Negotiation itself is guarded by
 * `enableWebRtcTier`'s in-flight check; this throttle just stops a flapping
 * connection from re-resolving keyring TURN creds on every transition.
 */
export const REUPGRADE_MIN_SPACING_MS = 15_000

/**
 * Minimum spacing between two automatic LAN re-resolution scans. Separate
 * (heavier) clock from `REUPGRADE_MIN_SPACING_MS` — a `scanLan` sweep costs
 * far more than a no-op `enableWebRtcTier`, so the two throttles must not
 * share a window. ADR-0021 LAN-first.
 */
export const LAN_RERESOLVE_MIN_SPACING_MS = 10_000

export interface MobileSignalingControllerOptions {
  /** Override platform detection for tests. */
  isCapacitorOverride?: boolean
  /** Test injection of the transport (defaults to the live module-scope `transport`). */
  transportOverride?: CompanionTransport
  /** Test injection of the settings reader (defaults to the Dexie `getSettings`). */
  getSettingsOverride?: () => Promise<AppSettings>
  /** Test injection of the network subscriber (defaults to `@/lib/capacitor/network`). */
  subscribeNetworkOverride?: typeof subscribeNetwork
  /** Test injection of the app-resume subscriber (defaults to `@/lib/capacitor/app`). */
  subscribeResumeOverride?: typeof subscribeResume
  /** Test injection of the clock used by the re-upgrade throttle. */
  nowOverride?: () => number
  /** Test injection of the LAN re-resolver (defaults to `resolveLanBaseUrl`). */
  resolveLanBaseUrlOverride?: typeof resolveLanBaseUrl
  /** Test injection of the TURN provisioner (defaults to `startTurnProvisioner`). */
  startTurnProvisionerOverride?: typeof startTurnProvisioner
}

/**
 * Install the controller. Returns an uninstall function. Re-installing
 * after uninstall is safe; concurrent installs share the live transport.
 */
export function installMobileSignalingController(
  options: MobileSignalingControllerOptions = {}
): () => void {
  const cap = options.isCapacitorOverride ?? isCapacitor()
  if (!cap) {
    return () => {
      // No-op outside Capacitor.
    }
  }

  // We need a typed reference to call `enableWebRtcTier` — the runtime
  // `transport` is the `Transport` interface, the upgrade method only
  // exists on `CompanionTransport`. Capacitor builds always pick
  // `CompanionTransport` (see `lib/tauri/transport-instance.ts`).
  const tx =
    (options.transportOverride as CompanionTransport | undefined) ??
    (transport as unknown as CompanionTransport)
  const readSettings = options.getSettingsOverride ?? getSettings
  const subscribeNetworkFn = options.subscribeNetworkOverride ?? subscribeNetwork
  const subscribeResumeFn = options.subscribeResumeOverride ?? subscribeResume
  const now = options.nowOverride ?? Date.now
  const resolveLan = options.resolveLanBaseUrlOverride ?? resolveLanBaseUrl
  const startProvisioner = options.startTurnProvisionerOverride ?? startTurnProvisioner

  // ADR-0021 — automatic ephemeral-TURN provisioning. The provisioner is a
  // sibling of the settings subscription (not nested in `applySettings`) so
  // it survives across re-runs and re-pushes fresh ICE servers on rotation.
  let provisioner: ProvisionerHandle | null = null
  let lastProviderKey = ""
  let lastSettings: AppSettings | null = null
  const manageProvisioner = (settings: AppSettings): void => {
    lastSettings = settings
    const tp = settings.turnProvider
    const key = tp && tp.kind !== "none" ? JSON.stringify(tp) : ""
    if (key === lastProviderKey) return
    lastProviderKey = key
    provisioner?.stop()
    provisioner = null
    if (key && tp) {
      provisioner = startProvisioner({
        provider: tp,
        onRefresh: () => {
          if (!lastSettings) return
          void applySettings(tx, lastSettings, provisioner?.current() ?? []).catch((err) => {
            console.warn("mobile-signaling-controller: provisioner re-push failed", err)
          })
        },
      })
    }
  }

  // ADR-0021 LAN-first re-resolution. The paired `baseUrl` is otherwise only
  // chosen at pair time, so after a network change it can keep pointing at a
  // tunnel even when the desktop is live on the LAN. On each reachability
  // trigger we probe (bounded, abortable) whether the desktop is reachable
  // on the LAN and, if so, repoint `baseUrl` + reconnect the WS so the
  // LAN-first gate (`isOnConnectedLan`) becomes true and the WebRTC tier is
  // torn down. Own throttle clock (heavier than re-upgrade) + single
  // in-flight scan (a newer trigger aborts the previous).
  let lastLanResolveMs = Number.NEGATIVE_INFINITY
  let lanAbort: AbortController | null = null
  const maybeReresolveLan = async (): Promise<void> => {
    const t = now()
    if (t - lastLanResolveMs < LAN_RERESOLVE_MIN_SPACING_MS) return
    lastLanResolveMs = t
    const config = loadCompanionConfig()
    if (!config) return
    // Already healthy on LAN — no need to scan.
    if (tx.isOnConnectedLan()) return
    lanAbort?.abort()
    const controller = new AbortController()
    lanAbort = controller
    let lanBaseUrl: string | null = null
    try {
      ;({ lanBaseUrl } = await resolveLan({ config, signal: controller.signal }))
    } catch {
      return
    }
    if (controller.signal.aborted) return
    if (lanBaseUrl && lanBaseUrl !== config.baseUrl) {
      await saveCompanionConfig({ ...config, baseUrl: lanBaseUrl })
      tx.reconnectWs()
    }
  }

  // First hydrate the CompanionConfig in case the caller didn't, so the
  // upgrade can run on a cold boot before the pair onboarding screen
  // mounts. Re-resolve LAN once hydration settles.
  void hydrateCompanionConfig()
    .then(() => maybeReresolveLan())
    .catch(() => {
      // Hydration errors land in the no-paired-device branch of
      // `enableWebRtcTier`; nothing to do here.
    })

  const sub: Subscription = liveQuery(() => readSettings()).subscribe({
    next: (settings) => {
      manageProvisioner(settings)
      void applySettings(tx, settings, provisioner?.current() ?? []).catch((err) => {
        console.warn("mobile-signaling-controller: applySettings failed", err)
      })
    },
    error: (err) => {
      console.warn("mobile-signaling-controller: settings query error", err)
    },
  })

  // Re-attempt the WebRTC upgrade when connectivity returns or the app
  // resumes. `enableWebRtcTier` is idempotent — a no-op while a peer is open
  // or connecting — so after the tier dropped to `failed` (backoff exhausted)
  // this re-promotes to WebRTC without a manual "Reconnect" tap or app
  // restart. Throttled so a flapping link doesn't thrash keyring TURN
  // resolution. `applySettings` self-gates: it disables the tier when
  // `webrtcEnabled === false`.
  // Seeded to -Infinity so the first trigger always fires (the throttle only
  // suppresses *subsequent* triggers within the window).
  let lastReupgradeMs = Number.NEGATIVE_INFINITY
  const reupgrade = async (): Promise<void> => {
    const t = now()
    if (t - lastReupgradeMs < REUPGRADE_MIN_SPACING_MS) return
    lastReupgradeMs = t
    try {
      const settings = await readSettings()
      manageProvisioner(settings)
      await applySettings(tx, settings, provisioner?.current() ?? [])
    } catch (err) {
      console.warn("mobile-signaling-controller: re-upgrade failed", err)
    }
  }

  // A reachability trigger: re-resolve the LAN baseUrl FIRST (so the
  // subsequent `applySettings` sees a truthful `isOnConnectedLan`), then
  // re-upgrade the WebRTC tier (throttled, self-gating).
  const onTrigger = async (): Promise<void> => {
    await maybeReresolveLan()
    await reupgrade()
  }

  let disposed = false
  let netUnsub: (() => void) | null = null
  let resumeUnsub: (() => void) | null = null
  void subscribeNetworkFn((status) => {
    if (status.connected) void onTrigger()
  }).then(
    (u) => {
      // Controller stopped while the subscribe was in flight — the dispose
      // below already ran with a null unsub, so drop the listener here.
      if (disposed) u()
      else netUnsub = u
    },
    () => {
      // Subscription setup failed (no plugin / no window) — re-upgrade is
      // best-effort; the settings liveQuery still drives the happy path.
    }
  )
  void subscribeResumeFn(() => {
    void onTrigger()
  }).then(
    (u) => {
      if (disposed) u()
      else resumeUnsub = u
    },
    () => {
      // Best-effort; see above.
    }
  )

  return () => {
    disposed = true
    sub.unsubscribe()
    netUnsub?.()
    resumeUnsub?.()
    lanAbort?.abort()
    provisioner?.stop()
  }
}

/**
 * Project an `AppSettings` snapshot onto the transport — exported for unit
 * testing without the `dexie.liveQuery` indirection. Test consumers `await`
 * this directly with handcrafted settings objects; the production caller
 * uses [`installMobileSignalingController`] and fires-and-forgets via
 * `.catch`.
 *
 * Returns a promise so callers (and tests) can observe completion. The
 * async path is needed because `resolveTurnServerCredentials` reads from
 * the OS keyring (`turn-credentials.ts`) — synchronously yielding before
 * `enableWebRtcTier` would skip credential resolution and surface as
 * "TURN auth failed" during ICE.
 */
export async function applySettings(
  tx: CompanionTransport,
  settings: AppSettings,
  providerServers: RTCIceServer[] = []
): Promise<void> {
  const enabled = settings.webrtcEnabled ?? true
  const signalingUrl = settings.signalingUrl ?? DEFAULT_SIGNALING_URL
  const ice = settings.iceServers ?? DEFAULT_STUN
  const turn = settings.turnServers ?? []
  if (!enabled) {
    tx.disableWebRtcTier()
    return
  }
  // ADR-0021 LAN-first: when already reaching the desktop over a connected
  // LAN, the WebRTC tier is not needed ("consulted only when LAN is
  // unavailable"). Tear it down to save mobile battery + signaling quota;
  // a later network-reconnect / resume trigger re-promotes it if LAN drops.
  if (tx.isOnConnectedLan()) {
    tx.disableWebRtcTier()
    return
  }
  const resolvedTurn = await resolveTurnServerCredentials(turn)
  // Static STUN/TURN first, then any provider-provisioned ephemeral relays
  // (ADR-0021). The ICE agent tries them all; provider servers are additive.
  const iceServers: RTCIceServer[] = [...ice, ...resolvedTurn, ...providerServers]
  await tx.enableWebRtcTier({
    signalingUrl,
    rtcConfiguration: { iceServers },
  })
}
