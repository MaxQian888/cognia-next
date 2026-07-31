// Visibility-aware loop that probes the active Codex account's usage windows at
// the user-configured cadence. Mirrors `lib/subscription/anthropic/scheduler.ts`
// (and reuses its cadence floor) but is credential-light: account resolution is
// injected so the loop has no direct vault coupling and stays testable offline.
//
// Two cadences:
//   - visible: page foregrounded (default 5 min)
//   - idle:    page hidden / no recent interaction (default 30 min)
// Neither runs faster than the shared 60s floor, so a forgotten tab can't hammer
// the backend.

import { clampCadence } from "@/lib/subscription/anthropic/scheduler"
import { probeCodexUsage } from "./usage-probe"

import type { CodexSubscriptionSettings, ProviderLimits } from "@/types/subscription"

export interface CodexSchedulerDeps {
  /** Active Codex account id, or null to pause the loop (no account). */
  getActiveAccountId: () => Promise<string | null> | string | null
  /** Probe one account. Defaults to `probeCodexUsage`. */
  probe?: (accountId: string) => Promise<ProviderLimits | null>
  /** Visibility helper — defaulted from `document.visibilityState`. */
  isVisible?: () => boolean
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

  function nextDelayMs(): number {
    const cfg = settings()
    return clampCadence(isVisible() ? cfg.visibleIntervalMs : cfg.idleIntervalMs)
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
