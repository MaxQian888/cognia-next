"use client"

/**
 * Client-side glue for every runtime whose live transport is a
 * `CompanionTransport` — a Capacitor phone, and a browser pointed at a cloud
 * `cognia-server` (ADR-0059's front-end/back-end split). It owns the parts of
 * staying connected that the transport itself does not: refreshing the channel
 * inventory, re-probing after the network returns, failing over between
 * channels, and opting into the WebRTC tier.
 *
 * It used to return a no-op for anything that was not Capacitor, which meant a
 * browser companion had none of it: it never learned the host's other
 * addresses, never re-probed on reconnect, never provisioned TURN, and never
 * got a WebRTC tier at all — only the transport's own WebSocket backoff. Every
 * one of those is host-neutral; the single genuinely Capacitor-bound piece is
 * local-network discovery (mDNS plus a /24 sweep), which a browser cannot do
 * and which is now the only thing gated.
 *
 * The Tauri desktop is excluded because it is the server peer, driven by
 * `desktop-controller.ts`.
 *
 * The file is still named `mobile-controller` so an active concurrent branch
 * does not have to rebase over a rename; the exported entry point carries the
 * accurate name.
 *
 * ADR-0021, ADR-0059.
 */

import Dexie, { type Subscription } from "dexie"

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
import { buildCandidates, pickReachable } from "@/lib/connectivity/connection-strategy"
import { refreshCompanionEndpoints } from "@/lib/connectivity/endpoint-refresh"
import { fetchHealthz } from "@/lib/connectivity/healthz"
import { hasWebCompanionTarget } from "@/lib/platform/web-companion"
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
  /**
   * Override Capacitor detection for tests. Also decides whether local-network
   * discovery runs: a browser cannot do mDNS or a subnet sweep.
   */
  isCapacitorOverride?: boolean
  /** Override browser-companion detection for tests. */
  hasWebCompanionTargetOverride?: boolean
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
  /** Test injection of the endpoint refresher (defaults to `refreshCompanionEndpoints`). */
  refreshEndpointsOverride?: typeof refreshCompanionEndpoints
  /**
   * Test injection of the per-candidate liveness probe used by the channel
   * failover sweep. Defaults to a `/healthz` probe that also verifies the
   * server's self-signed TLS fingerprint against the stored pin.
   */
  probeCandidateOverride?: (baseUrl: string, signal: AbortSignal) => Promise<boolean>
}

/** Per-candidate probe budget during a failover sweep (ms). */
const CANDIDATE_PROBE_TIMEOUT_MS = 1500

/**
 * Default liveness probe for the channel failover sweep.
 *
 * `/healthz` reports the desktop's OWN self-signed SPKI fingerprint no matter
 * which channel the request arrived on — so it identifies the host even over
 * a Cloudflare-terminated tunnel, where the TLS certificate the client sees
 * belongs to Cloudflare rather than the desktop. When the device holds a pin,
 * a mismatch rejects the candidate: a squatted tunnel hostname must not be
 * able to attract the connection.
 */
export async function probeCandidateDefault(
  baseUrl: string,
  signal: AbortSignal,
  expectedFingerprint?: string,
  fetchHealthzImpl: typeof fetchHealthz = fetchHealthz
): Promise<boolean> {
  const health = await fetchHealthzImpl(baseUrl, {
    signal,
    timeoutMs: CANDIDATE_PROBE_TIMEOUT_MS,
  })
  if (!health) return false
  if (!expectedFingerprint) return true
  return health.fingerprint.toLowerCase() === expectedFingerprint.toLowerCase()
}

/**
 * Does this transport actually expose the surface the controller drives?
 *
 * Every method named here is called unconditionally below, so the guard and
 * the call sites must stay in step; a missing one is a TypeError at the first
 * transition rather than a degraded controller.
 */
function isCompanionTransport(value: unknown): value is CompanionTransport {
  if (!value || typeof value !== "object") return false
  const record = value as Record<string, unknown>
  return [
    "onConnectionStateChange",
    "getConnectionState",
    "reconnectWs",
    "isOnConnectedLan",
    "enableWebRtcTier",
    "disableWebRtcTier",
  ].every((method) => typeof record[method] === "function")
}

/**
 * Install the controller. Returns an uninstall function. Re-installing
 * after uninstall is safe; concurrent installs share the live transport.
 *
 * A no-op on any runtime whose transport is not a `CompanionTransport` — the
 * Tauri desktop (it is the peer) and a plain web build with no configured
 * server.
 *
 * That is decided on the transport, not only on the runtime. A web-companion
 * runtime holds the `WebStubTransport` (`call` + `subscribe`, nothing else)
 * until a pairing resolves, and `suspendCompanionTransport` puts it back
 * mid-pair before notifying — which re-runs this installer against the stub.
 * The runtime check says "yes, a companion build" and the cast used to say
 * "trust me, it is a CompanionTransport", so the first `onConnectionStateChange`
 * threw a TypeError inside `enterOffline` and killed the pairing that was in
 * flight. Waiting is correct rather than lossy: installing the real transport
 * notifies again, and this installer runs once more with something to drive.
 */
export function installCompanionSignalingController(
  options: MobileSignalingControllerOptions = {}
): () => void {
  const capacitor = options.isCapacitorOverride ?? isCapacitor()
  const webCompanion = options.hasWebCompanionTargetOverride ?? hasWebCompanionTarget()
  if (!capacitor && !webCompanion) {
    return () => {
      // No CompanionTransport on this runtime — nothing to drive.
    }
  }
  // mDNS and the /24 probe sweep need native networking. A browser skips
  // discovery and relies on the addresses the host reports over the
  // authenticated connection instead.
  const canScanLan = capacitor

  // We need a typed reference to call `enableWebRtcTier` — the runtime
  // `transport` is the `Transport` interface, the upgrade method only
  // exists on `CompanionTransport`. Both Capacitor and web-companion builds
  // resolve to `CompanionTransport` (see `lib/tauri/transport-instance.ts`).
  const candidate = options.transportOverride ?? (transport as unknown)
  if (!isCompanionTransport(candidate)) {
    return () => {
      // The stub is in place — there is nothing to drive yet.
    }
  }
  const tx = candidate
  const readSettings = options.getSettingsOverride ?? getSettings
  const subscribeNetworkFn = options.subscribeNetworkOverride ?? subscribeNetwork
  const subscribeResumeFn = options.subscribeResumeOverride ?? subscribeResume
  const now = options.nowOverride ?? Date.now
  const resolveLan = options.resolveLanBaseUrlOverride ?? resolveLanBaseUrl
  const startProvisioner = options.startTurnProvisionerOverride ?? startTurnProvisioner
  const refreshEndpoints = options.refreshEndpointsOverride ?? refreshCompanionEndpoints
  const probeCandidate =
    options.probeCandidateOverride ??
    ((baseUrl: string, signal: AbortSignal) =>
      probeCandidateDefault(baseUrl, signal, loadCompanionConfig()?.serverFingerprint))

  // ADR-0021 — automatic ephemeral-TURN provisioning. The provisioner is a
  // sibling of the settings subscription (not nested in `applySettings`) so
  // it survives across re-runs and re-pushes fresh ICE servers on rotation.
  let provisioner: ProvisionerHandle | null = null
  let lastProviderKey = ""
  let lastSettings: AppSettings | null = null
  let providerGeneration = 0
  let configurationGeneration = 0

  const applyCurrentSettings = (
    settings: AppSettings,
    providerServers: RTCIceServer[]
  ): Promise<void> => {
    const generation = ++configurationGeneration
    return applySettings(
      tx,
      settings,
      providerServers,
      () => generation === configurationGeneration
    )
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
    if (key && tp) {
      provisioner = startProvisioner({
        provider: tp,
        onRefresh: (iceServers) => {
          if (generation !== providerGeneration || !lastSettings) return
          void applyCurrentSettings(lastSettings, iceServers).catch((err) => {
            console.warn("mobile-signaling-controller: provisioner re-push failed", err)
          })
        },
      })
    }
  }

  // ADR-0021 LAN-first re-resolution, then channel failover. The paired
  // `baseUrl` is otherwise only chosen at pair time, so after a network change
  // it can keep pointing at a tunnel even when the desktop is live on the LAN
  // — or, worse, at a LAN address that no longer resolves at all.
  //
  // On each reachability trigger:
  //   1. probe (bounded, abortable) whether the desktop is reachable on the
  //      LAN and, if so, repoint `baseUrl` + reconnect the WS so the LAN-first
  //      gate (`isOnConnectedLan`) becomes true and the WebRTC tier is torn
  //      down;
  //   2. if there is no LAN and the transport is NOT currently connected,
  //      sweep the remaining channels (cached LAN address → tunnel → the
  //      pair-time address) and repoint at the first that answers. Without
  //      this step a phone that paired on the LAN has no route home once it
  //      leaves the network except the WebRTC tier, which is unavailable when
  //      the user disabled it, the signaling service is unreachable, or a
  //      symmetric NAT offers no relay.
  //
  // Own throttle clock (heavier than re-upgrade) + single in-flight sweep (a
  // newer trigger aborts the previous).
  let lastLanResolveMs = Number.NEGATIVE_INFINITY
  let lanAbort: AbortController | null = null
  const maybeRepointTransport = async (): Promise<void> => {
    const t = now()
    if (t - lastLanResolveMs < LAN_RERESOLVE_MIN_SPACING_MS) return
    lastLanResolveMs = t
    const config = loadCompanionConfig()
    if (!config) return
    // Already healthy on LAN — the best channel is in use, nothing to do.
    if (tx.isOnConnectedLan()) return
    lanAbort?.abort()
    const controller = new AbortController()
    lanAbort = controller

    let lanBaseUrl: string | null = null
    if (canScanLan) {
      try {
        ;({ lanBaseUrl } = await resolveLan({ config, signal: controller.signal }))
      } catch {
        // Scan failure is not fatal — fall through to the failover sweep, which
        // probes concrete addresses rather than discovering new ones.
      }
    }
    // A browser has no discovery, so it goes straight to the sweep below. That
    // is not a downgrade: the sweep probes the concrete addresses the host
    // reported through `companion_endpoints`, which is the only way a browser
    // could learn them anyway.
    if (controller.signal.aborted) return
    if (lanBaseUrl) {
      if (lanBaseUrl !== config.baseUrl) {
        await saveCompanionConfig({ ...config, baseUrl: lanBaseUrl })
        tx.reconnectWs()
      }
      return
    }

    // No LAN. A live connection over some other channel must not be torn down
    // to go probing — only sweep when we have actually lost the desktop.
    if (tx.getConnectionState() === "connected") return

    const candidates = buildCandidates({
      // Server-reported LAN address from `companion_endpoints`. The live scan
      // above already failed, but it can miss a subnet the phone can still
      // route to (mDNS blocked, /24 sweep on the wrong interface), and the
      // probe below verifies the pin before we commit to it.
      lanBaseUrl: config.lanBaseUrl,
      tunnelUrl: config.tunnelBaseUrl,
      cachedBaseUrl: config.baseUrl,
      expectedFingerprint: config.serverFingerprint,
    })
    if (candidates.length === 0) return
    const winner = await pickReachable(candidates, (candidate) =>
      probeCandidate(candidate.baseUrl, controller.signal)
    )
    if (controller.signal.aborted) return
    if (winner && winner.baseUrl !== config.baseUrl) {
      await saveCompanionConfig({ ...config, baseUrl: winner.baseUrl })
      tx.reconnectWs()
    }
  }

  // First hydrate the CompanionConfig in case the caller didn't, so the
  // upgrade can run on a cold boot before the pair onboarding screen
  // mounts. Re-resolve LAN once hydration settles.
  void hydrateCompanionConfig()
    .then(() => maybeRepointTransport())
    .catch(() => {
      // Hydration errors land in the no-paired-device branch of
      // `enableWebRtcTier`; nothing to do here.
    })

  // ADR-0021 channel inventory. The pair payload carries ONE address, so the
  // set of channels a device knows about is only ever refreshed here, over an
  // authenticated connection. Runs on each transition INTO `connected` —
  // that's the one moment the RPC is guaranteed to be answerable, and it is
  // exactly when a newly-started tunnel (or a fingerprint the tunnel pairing
  // could not carry) needs to reach the phone. Fire-and-forget: the refresher
  // never throws, and nothing downstream waits on it.
  const runEndpointRefresh = (): void => {
    void refreshEndpoints().catch((err) => {
      console.warn("mobile-signaling-controller: endpoint refresh failed", err)
    })
  }
  const detachConnectionState = tx.onConnectionStateChange((state) => {
    if (state !== "connected") return
    runEndpointRefresh()
  })
  // `onConnectionStateChange` does not seed the listener with the current value
  // (unlike `onTierChange`), so a controller installed while the transport is
  // ALREADY connected would never see a transition and would never refresh —
  // which is the common case on a warm remount. Seed it here.
  if (tx.getConnectionState() === "connected") runEndpointRefresh()

  // `Dexie.liveQuery`, not a named `liveQuery` import: dexie's CJS build makes
  // `liveQuery` non-enumerable, so SWC's wildcard interop drops it the moment a
  // module also imports the `Dexie` default. See `lib/db/outbound-jobs.ts`.
  const sub: Subscription = Dexie.liveQuery(() => readSettings()).subscribe({
    next: (settings) => {
      manageProvisioner(settings)
      void applyCurrentSettings(settings, provisioner?.current() ?? []).catch((err) => {
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
      await applyCurrentSettings(settings, provisioner?.current() ?? [])
    } catch (err) {
      console.warn("mobile-signaling-controller: re-upgrade failed", err)
    }
  }

  // A reachability trigger: re-resolve the LAN baseUrl FIRST (so the
  // subsequent `applySettings` sees a truthful `isOnConnectedLan`), then
  // re-upgrade the WebRTC tier (throttled, self-gating).
  const onTrigger = async (): Promise<void> => {
    await maybeRepointTransport()
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
    providerGeneration += 1
    configurationGeneration += 1
    sub.unsubscribe()
    netUnsub?.()
    resumeUnsub?.()
    detachConnectionState()
    lanAbort?.abort()
    provisioner?.stop()
  }
}

/**
 * Project an `AppSettings` snapshot onto the transport — exported for unit
 * testing without the `dexie.liveQuery` indirection. Test consumers `await`
 * this directly with handcrafted settings objects; the production caller
 * uses [`installCompanionSignalingController`] and fires-and-forgets via
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
  providerServers: RTCIceServer[] = [],
  isCurrent: () => boolean = () => true
): Promise<void> {
  const enabled = settings.webrtcEnabled ?? true
  if (!enabled) {
    tx.disableWebRtcTier()
    return
  }
  const targetConfig = loadCompanionConfig()
  if (!targetConfig) {
    // The controller can mount before the async credential-book hydration
    // completes. Starting a tier in that window can only warn "not paired";
    // there is no rendezvous identity to negotiate with yet. The config-change
    // notification re-installs the controller once hydration/pairing succeeds.
    tx.disableWebRtcTier()
    return
  }
  const signalingUrl = targetConfig.signalingUrl ?? settings.signalingUrl ?? DEFAULT_SIGNALING_URL
  const ice = targetConfig.iceServers ?? settings.iceServers ?? DEFAULT_STUN
  const turn = settings.turnServers ?? []
  // ADR-0021 LAN-first: when already reaching the desktop over a connected
  // LAN, the WebRTC tier is not needed ("consulted only when LAN is
  // unavailable"). Tear it down to save mobile battery + signaling quota;
  // a later network-reconnect / resume trigger re-promotes it if LAN drops.
  if (tx.isOnConnectedLan()) {
    tx.disableWebRtcTier()
    return
  }
  const resolvedTurn = await resolveTurnServerCredentials(turn)
  if (!isCurrent()) return
  // Static STUN/TURN first, then any provider-provisioned ephemeral relays
  // (ADR-0021). The ICE agent tries them all; provider servers are additive.
  const iceServers: RTCIceServer[] = [...ice, ...resolvedTurn, ...providerServers]
  await tx.enableWebRtcTier({
    signalingUrl,
    rtcConfiguration: { iceServers },
  })
}
