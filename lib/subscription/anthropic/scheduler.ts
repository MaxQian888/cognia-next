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
// `refreshAccessToken` + `subscription_save_account` + `subscription_set_active`)
// and retry once. After a successful probe we persist via `recordUsageSnapshot`.

import type { AnthropicCredentialData, AnthropicSubscriptionSettings } from "@/types/subscription"
import { isAnthropicCredentialFresh } from "./oauth"
import { probeOnce } from "./usage-probe"
import { recordUsageSnapshot } from "./usage-collector"

export interface SchedulerDeps {
  /** Read the latest credential. Returning null pauses the loop. */
  getCredential: () => Promise<AnthropicCredentialData | null> | AnthropicCredentialData | null
  /** Triggered on 401; should refresh + persist + return the new credential. */
  refresh: (current: AnthropicCredentialData) => Promise<AnthropicCredentialData | null>
  /** Visibility helper — defaulted from `document.visibilityState` in real use. */
  isVisible?: () => boolean
  /** Hook for tests to skip persistence. */
  persist?: typeof recordUsageSnapshot
}

export interface SchedulerHandle {
  /** Stop the loop. Idempotent. */
  stop: () => void
  /** Force a probe outside the cadence. */
  triggerNow: () => Promise<void>
}

export function startUsageScheduler(
  settings: () => Pick<
    AnthropicSubscriptionSettings,
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
      if (!cfg.probeEnabled) return
      const credential = await deps.getCredential()
      if (!credential || !isAnthropicCredentialFresh(credential)) return
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

/** Floor for active-probe cadence — 60s minimum. */
export const PROBE_CADENCE_FLOOR_MS = 60_000

/** Clamp an arbitrary user-supplied cadence to the floor. */
export function clampCadence(value: number): number {
  if (!Number.isFinite(value)) return PROBE_CADENCE_FLOOR_MS
  return Math.max(PROBE_CADENCE_FLOOR_MS, Math.floor(value))
}
