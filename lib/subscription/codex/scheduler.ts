// Visibility-aware loop that probes the active Codex account's usage windows at
// the user-configured cadence. Mirrors `lib/subscription/anthropic/scheduler.ts`
// (and reuses its cadence floor) but is credential-light: account resolution is
// injected so the loop has no direct vault coupling and stays testable offline.
//
// Two cadences:
//   - visible: page foregrounded (default 5 min)
//   - idle:    page hidden / no recent interaction (default 30 min)
// Neither runs faster than the shared 60s floor, so a forgotten tab can't hammer
// the backend, and both are jittered so parallel loops do not fire together.
//
// The probe itself goes through the shared limits coalescer, so a provider
// block armed by the quota panel (or by an earlier tick) is honored here too.
// This loop used to reach the runner directly and was the one caller that saw
// neither the throttle nor the block.

import { clampCadence, PROBE_CADENCE_JITTER_RATIO } from "@/lib/subscription/anthropic/scheduler"
import { jitterCadenceMs } from "@/lib/subscription/retry/backoff"
import { probeCodexUsage } from "./usage-probe"

import type { CodexSubscriptionSettings, ProviderLimits } from "@/types/subscription"

export interface CodexSchedulerDeps {
  /** Active Codex account id, or null to pause the loop (no account). */
  getActiveAccountId: () => Promise<string | null> | string | null
  /** Probe one account. Defaults to `probeCodexUsage`. */
  probe?: (accountId: string) => Promise<ProviderLimits | null>
  /** Visibility helper — defaulted from `document.visibilityState`. */
  isVisible?: () => boolean
  /** Deterministic jitter source for tests. Defaults to `Math.random`. */
  random?: () => number
}

export interface CodexSchedulerHandle {
  /** Stop the loop. Idempotent. */
  stop: () => void
  /** Force a probe outside the cadence. */
  triggerNow: () => Promise<void>
}

export function startCodexUsageScheduler(
  settings: () => Pick<
    CodexSubscriptionSettings,
    "probeEnabled" | "visibleIntervalMs" | "idleIntervalMs"
  >,
  deps: CodexSchedulerDeps
): CodexSchedulerHandle {
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | null = null
  const isVisible = deps.isVisible ?? defaultIsVisible
  const probe = deps.probe ?? probeCodexUsage
  const random = deps.random ?? Math.random

  function nextDelayMs(): number {
    const cfg = settings()
    // Jittered for the same reason the Anthropic loop is: the cadence is a
    // user setting, so every account and every open window shares it and they
    // would otherwise realign onto one tick.
    const cadence = clampCadence(isVisible() ? cfg.visibleIntervalMs : cfg.idleIntervalMs)
    return jitterCadenceMs(cadence, PROBE_CADENCE_JITTER_RATIO, random)
  }

  async function tick() {
    if (stopped) return
    try {
      const cfg = settings()
      if (!cfg.probeEnabled) return
      const accountId = await deps.getActiveAccountId()
      if (!accountId) return
      await probe(accountId)
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
