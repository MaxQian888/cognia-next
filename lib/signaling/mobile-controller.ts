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
import { CompanionTransport, hydrateCompanionConfig } from "@/lib/tauri/transport-companion"
import { getSettings } from "@/lib/db/settings"
import { resolveTurnServerCredentials } from "@/lib/credentials/turn-credentials"
import type { AppSettings } from "@/lib/claude/types"

const DEFAULT_SIGNALING_URL = "wss://signaling.cognia.app/v1/signaling"
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

  // First hydrate the CompanionConfig in case the caller didn't, so the
  // upgrade can run on a cold boot before the pair onboarding screen
  // mounts.
  void hydrateCompanionConfig().catch(() => {
    // Hydration errors land in the no-paired-device branch of
    // `enableWebRtcTier`; nothing to do here.
  })

  const sub: Subscription = liveQuery(() => readSettings()).subscribe({
    next: (settings) => {
      void applySettings(tx, settings).catch((err) => {
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
      await applySettings(tx, await readSettings())
    } catch (err) {
      console.warn("mobile-signaling-controller: re-upgrade failed", err)
    }
  }

  let netUnsub: (() => void) | null = null
  let resumeUnsub: (() => void) | null = null
  void subscribeNetworkFn((status) => {
    if (status.connected) void reupgrade()
  }).then(
    (u) => {
      netUnsub = u
    },
    () => {
      // Subscription setup failed (no plugin / no window) — re-upgrade is
      // best-effort; the settings liveQuery still drives the happy path.
    }
  )
  void subscribeResumeFn(() => {
    void reupgrade()
  }).then(
    (u) => {
      resumeUnsub = u
    },
    () => {
      // Best-effort; see above.
    }
  )

  return () => {
    sub.unsubscribe()
    netUnsub?.()
    resumeUnsub?.()
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
export async function applySettings(tx: CompanionTransport, settings: AppSettings): Promise<void> {
  const enabled = settings.webrtcEnabled ?? true
  const signalingUrl = settings.signalingUrl ?? DEFAULT_SIGNALING_URL
  const ice = settings.iceServers ?? DEFAULT_STUN
  const turn = settings.turnServers ?? []
  if (!enabled) {
    tx.disableWebRtcTier()
    return
  }
  const resolvedTurn = await resolveTurnServerCredentials(turn)
  const iceServers: RTCIceServer[] = [...ice, ...resolvedTurn]
  await tx.enableWebRtcTier({
    signalingUrl,
    rtcConfiguration: { iceServers },
  })
}
