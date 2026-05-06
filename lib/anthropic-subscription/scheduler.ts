// Visibility-aware loop that drives `probeOnce` at the user-configured cadence.
//
// Two cadences:
//   - visible:  page is foregrounded (default 5 min)
//   - idle:     page is hidden / no recent interaction (default 30 min)
//
// The loop never runs in the background tab faster than the idle cadence so
// a forgotten browser tab doesn't drain quota on the user's behalf.
//
// On 401: trigger a refresh callback (the hooks layer wires this into
// `refreshAccessToken` + `saveCredential` + `syncCredentialToSidecar`) and
// retry once. After a successful probe we persist via `recordUsageSnapshot`.

import { isCredentialFresh } from "./credential-store"
import type { SubscriptionCredential, SubscriptionSettings } from "./types"
import { probeOnce } from "./usage-probe"
import { recordUsageSnapshot } from "./usage-collector"

export interface SchedulerDeps {
  /** Read the latest credential. Returning null pauses the loop. */
  getCredential: () => Promise<SubscriptionCredential | null> | SubscriptionCredential | null
  /** Triggered on 401; should refresh + persist + return the new credential. */
  refresh: (current: SubscriptionCredential) => Promise<SubscriptionCredential | null>
  /** Visibility helper — defaulted from `document.visibilityState` in real use. */
  isVisible?: () => boolean
  /** Hook for tests to skip persistence. */
  persist?: typeof recordUsageSnapshot
}

export interface SchedulerHandle {
  /** Stop the loop. Idempotent. */
  stop: () => void
  /**
   * Force a probe outside the cadence (e.g. UI "Run a probe now" button).
   * Resolves with the same shape `probeOnce` returns.
   */
  triggerNow: () => Promise<void>
}

/**
 * Start the loop. `settings` is read on every tick so a settings change
 * (cadence edit) takes effect on the next iteration without restarting.
 */
export function startUsageScheduler(
  settings: () => Pick<
    SubscriptionSettings,
    "probeEnabled" | "visibleIntervalMs" | "idleIntervalMs"
  >,
  deps: SchedulerDeps
): SchedulerHandle {
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | null = null
  const isVisible = deps.isVisible ?? defaultIsVisible
  const persist = deps.persist ?? recordUsageSnapshot

  function nextDelayMs(): number {
    const cfg = settings()
    return isVisible() ? cfg.visibleIntervalMs : cfg.idleIntervalMs
  }

  async function tick() {
    if (stopped) return
    try {
      const cfg = settings()
      if (!cfg.probeEnabled) return // settings off → wait one cadence and re-check
      const credential = await deps.getCredential()
      if (!credential || !isCredentialFresh(credential)) return
      let outcome = await probeOnce(credential)
      if (!outcome.ok && outcome.reason === "auth") {
        const refreshed = await deps.refresh(credential)
        if (refreshed) outcome = await probeOnce(refreshed)
      }
      if (outcome.ok) {
        await persist(outcome.snapshot)
      }
    } finally {
      if (!stopped) {
        timer = setTimeout(tick, nextDelayMs())
      }
    }
  }

  // First tick fires immediately so the user sees a snapshot quickly after
  // enabling the probe. Subsequent ticks honour the cadence.
  timer = setTimeout(tick, 0)

  return {
    stop() {
      stopped = true
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
    },
    async triggerNow() {
      await tick()
    },
  }
}

function defaultIsVisible(): boolean {
  if (typeof document === "undefined") return false
  return document.visibilityState !== "hidden"
}

/** Floor for active-probe cadence. The plan calls for 60s minimum. */
export const PROBE_CADENCE_FLOOR_MS = 60_000

/** Clamp an arbitrary user-supplied cadence to the floor. */
export function clampCadence(value: number): number {
  if (!Number.isFinite(value)) return PROBE_CADENCE_FLOOR_MS
  return Math.max(PROBE_CADENCE_FLOOR_MS, Math.floor(value))
}
