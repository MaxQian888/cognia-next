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

import { isCapacitor, transport } from "@/lib/tauri"
import { CompanionTransport, hydrateCompanionConfig } from "@/lib/tauri/transport-companion"
import { getSettings } from "@/lib/db/settings"
import type { AppSettings } from "@/lib/claude/types"

const DEFAULT_SIGNALING_URL = "wss://signaling.cognia.app/v1/signaling"
const DEFAULT_STUN: RTCIceServer[] = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun.cloudflare.com:3478" },
]

export interface MobileSignalingControllerOptions {
  /** Override platform detection for tests. */
  isCapacitorOverride?: boolean
  /** Test injection of the transport (defaults to the live module-scope `transport`). */
  transportOverride?: CompanionTransport
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

  // First hydrate the CompanionConfig in case the caller didn't, so the
  // upgrade can run on a cold boot before the pair onboarding screen
  // mounts.
  void hydrateCompanionConfig().catch(() => {
    // Hydration errors land in the no-paired-device branch of
    // `enableWebRtcTier`; nothing to do here.
  })

  const sub: Subscription = liveQuery(() => getSettings()).subscribe({
    next: (settings) => {
      applySettings(tx, settings)
    },
    error: (err) => {
      console.warn("mobile-signaling-controller: settings query error", err)
    },
  })

  return () => {
    sub.unsubscribe()
  }
}

/**
 * Project an `AppSettings` snapshot onto the transport — exported for unit
 * testing without the `dexie.liveQuery` indirection. Test consumers call
 * this directly with handcrafted settings objects; the production caller
 * uses [`installMobileSignalingController`].
 */
export function applySettings(tx: CompanionTransport, settings: AppSettings): void {
  const enabled = settings.webrtcEnabled ?? true
  const signalingUrl = settings.signalingUrl ?? DEFAULT_SIGNALING_URL
  const ice = settings.iceServers ?? DEFAULT_STUN
  const turn = settings.turnServers ?? []
  if (!enabled) {
    tx.disableWebRtcTier()
    return
  }
  const iceServers: RTCIceServer[] = [...ice, ...turn]
  void tx
    .enableWebRtcTier({
      signalingUrl,
      rtcConfiguration: { iceServers },
    })
    .catch((err) => {
      console.warn("mobile-signaling-controller: enableWebRtcTier failed", err)
    })
}
