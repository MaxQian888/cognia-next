"use client"

/**
 * `useLoadingPhase` — time-driven escalation for a wait that is already on
 * screen. Generalises the chat-only ladder in `hooks/chat/use-thinking-phase.ts`
 * so every long operation can say more than "spinning".
 *
 *   visible     the indicator is up, nothing extra to say
 *   prolonged   (≥5s) the wait is long enough to deserve reassurance plus an
 *               elapsed count, so the user can tell progress from a hang
 *   escalated   (≥15s) offer a way out — only reachable when the caller passed
 *               a real cancel, because an escalation with no action is just a
 *               more alarming spinner
 *
 * Mount is the activation signal and unmount tears the timers down, exactly as
 * `useThinkingPhase` does. There is deliberately no `active` flag: gating on one
 * would require a synchronous `setState` inside the effect, which
 * `react-hooks/set-state-in-effect` forbids for `hooks/**`. Callers mount this
 * (via `LoadingRegion`) only while the indicator is visible.
 *
 * Offline is reported only once the wait is prolonged. A device that blips
 * offline during a fast local read has not made that read fail, and swapping
 * the copy for it would be a lie; a wait that is *both* long and offline almost
 * certainly is the network, and saying so beats spinning forever.
 */

import { useEffect, useState } from "react"

import { useNetworkStatus } from "@/hooks/use-network-status"

/** Reassurance + elapsed count appear once the wait crosses this. */
export const PROLONGED_AT_MS = 5000
/** A cancel affordance is offered once the wait crosses this. */
export const ESCALATED_AT_MS = 15000
/** How often the elapsed count refreshes. */
export const ELAPSED_TICK_MS = 1000

export type LoadingPhaseName = "visible" | "prolonged" | "escalated"

export interface LoadingPhaseOptions {
  /** Escalation is unreachable unless the caller can actually cancel. */
  canEscalate?: boolean
  prolongedAtMs?: number
  escalatedAtMs?: number
  tickMs?: number
  /**
   * Anchor the elapsed count to a moment before this mount. The boot screen
   * is re-mounted by successive owners during one wait (see
   * `lib/boot/boot-progress.ts`); anchoring to the shared sequence start keeps
   * "still working (7s)" honest across the hand-overs instead of resetting to
   * zero at each one. `null` / `undefined` means "since mount", as before.
   */
  startedAt?: number | null
}

export interface LoadingPhase {
  phase: LoadingPhaseName
  elapsedMs: number
  /** Prolonged AND the device reports no connection. */
  offline: boolean
}

export function useLoadingPhase(options: LoadingPhaseOptions = {}): LoadingPhase {
  const {
    canEscalate = false,
    prolongedAtMs = PROLONGED_AT_MS,
    escalatedAtMs = ESCALATED_AT_MS,
    tickMs = ELAPSED_TICK_MS,
    startedAt = null,
  } = options

  // Seeded from the anchor when there is one, so a re-mount mid-wait reports
  // the true elapsed time on its very first render rather than flickering
  // back to zero until the first tick. Without an anchor the wait starts now.
  const [elapsedMs, setElapsedMs] = useState(() =>
    startedAt === null ? 0 : Math.max(0, Date.now() - startedAt)
  )
  const { status } = useNetworkStatus()

  useEffect(() => {
    const origin = startedAt ?? Date.now()
    const interval = setInterval(() => {
      setElapsedMs(Math.max(0, Date.now() - origin))
    }, tickMs)
    return () => clearInterval(interval)
  }, [tickMs, startedAt])

  const prolonged = elapsedMs >= prolongedAtMs
  const phase: LoadingPhaseName =
    canEscalate && elapsedMs >= escalatedAtMs ? "escalated" : prolonged ? "prolonged" : "visible"

  return { phase, elapsedMs, offline: prolonged && !status.connected }
}
