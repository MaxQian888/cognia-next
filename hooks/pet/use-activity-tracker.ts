// Main-window user-activity tracker (VPet-style Smart-Moving signal). Two
// consumers: the proactive idle trigger reads `markActivity` via the shared
// activity-signal module, and the desktop overlay's wander gate receives a
// THROTTLED bridge ping (≤1 per window) so an idle user eventually parks the
// pet even with `onlyAfterInteraction` on.
//
// Listeners are passive/capture and do near-zero work per event: a module-set
// write, plus at most one BroadcastChannel post per throttle window. No React
// state — this hook never re-renders its host.

"use client"

import { useEffect } from "react"

import { markActivity } from "@/lib/pet/llm/proactive/activity-signal"
import { PET_BRIDGE_CHANNEL, encodePetBridgeMessage } from "@/lib/pet/events/cross-window-protocol"
import type { BroadcastChannelLike } from "@/lib/pet/events/cross-window-bridge"

/** At most one bridge ping per window; the wander gate works in minutes. */
export const ACTIVITY_POST_THROTTLE_MS = 10_000

const EVENTS = ["pointermove", "pointerdown", "keydown", "focus"] as const

export interface UseActivityTrackerDeps {
  /** DI for tests; default = a real BroadcastChannel (null when unsupported). */
  channel?: BroadcastChannelLike | null
  now?: () => number
}

export function useActivityTracker(enabled: boolean, deps: UseActivityTrackerDeps = {}): void {
  // Effect deps: `deps` is a test-only seam; production passes nothing, so
  // depending on `enabled` alone keeps the listeners stable across renders.
  const channelDep = deps.channel
  const nowDep = deps.now

  useEffect(() => {
    if (!enabled) return
    const now = nowDep ?? Date.now
    const channel: BroadcastChannelLike | null =
      channelDep !== undefined
        ? channelDep
        : typeof BroadcastChannel === "undefined"
          ? null
          : (new BroadcastChannel(PET_BRIDGE_CHANNEL) as unknown as BroadcastChannelLike)

    let lastPostedAt = -Infinity
    const onActivity = () => {
      const at = now()
      markActivity(at)
      if (channel && at - lastPostedAt >= ACTIVITY_POST_THROTTLE_MS) {
        lastPostedAt = at
        channel.postMessage(encodePetBridgeMessage({ v: 1, t: "activity", at }))
      }
    }

    for (const ev of EVENTS) {
      window.addEventListener(ev, onActivity, { capture: true, passive: true })
    }
    return () => {
      for (const ev of EVENTS) {
        window.removeEventListener(ev, onActivity, { capture: true })
      }
      // Only close channels we created ourselves.
      if (channelDep === undefined) channel?.close()
    }
  }, [enabled, channelDep, nowDep])
}
