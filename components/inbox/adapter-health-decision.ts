/**
 * Shared health-badge decision + presentation tables.
 *
 * Extracted from `adapter-health-badge.tsx` so the Settings → Connections →
 * Adapters list row can reuse the exact same "quiet when healthy, loud when
 * not" predicate and colour/icon mapping without duplicating it. The inbox
 * badge re-exports `decideBadge` for its `__TESTING__` hook; the adapters
 * row consumes `decideBadge` + `STATE_TINT` + `STATE_ICON` directly and
 * supplies its own i18n labels.
 */

import { AlertOctagonIcon, AlertTriangleIcon, ZapOffIcon, type LucideIcon } from "lucide-react"

import type { UseAdapterHealthResult } from "@/hooks/connectors/use-adapter-health"

export type BadgeState = "breaker-open" | "rate-limited" | "degraded" | "down"

export interface BadgeDecision {
  state: BadgeState
  reason?: string
  /** Epoch ms when the state is expected to resolve naturally. */
  etaMs?: number
}

/**
 * Inspect the hook result and decide whether to render. Returns `null`
 * when the adapter is nominal — the badge is hidden in that case. Order
 * matters: breaker open trumps a tripped rate limit (the operator should
 * fix the upstream failure first), and both trump generic degraded/down.
 */
export function decideBadge(health: UseAdapterHealthResult): BadgeDecision | null {
  if (health.breaker?.state === "open") {
    // Breaker carries openedAt; we cannot compute the precise cooldown
    // here without the breaker config, so we surface the openedAt as
    // the visible signal and let the operator infer recovery via the
    // detail panel.
    return {
      state: "breaker-open",
      reason: health.lastError?.message ?? health.lastError?.reason,
    }
  }
  if (health.rateBucket && health.rateBucket.available === 0) {
    return {
      state: "rate-limited",
      etaMs: health.rateBucket.nextRefillAt ?? undefined,
    }
  }
  const currentState = health.current.state
  if (currentState === "degraded") {
    return {
      state: "degraded",
      reason: health.lastError?.message ?? health.lastError?.reason,
    }
  }
  if (currentState === "down") {
    return {
      state: "down",
      reason: health.lastError?.message ?? health.lastError?.reason,
    }
  }
  return null
}

export const STATE_TINT: Record<BadgeState, string> = {
  "breaker-open": "border-destructive/40 bg-destructive/10 text-destructive",
  "rate-limited":
    "border-amber-300/60 bg-amber-100/60 text-amber-900 dark:border-amber-700/60 dark:bg-amber-900/30 dark:text-amber-100",
  degraded:
    "border-amber-300/60 bg-amber-100/60 text-amber-900 dark:border-amber-700/60 dark:bg-amber-900/30 dark:text-amber-100",
  down: "border-destructive/40 bg-destructive/10 text-destructive",
}

export const STATE_ICON: Record<BadgeState, LucideIcon> = {
  "breaker-open": AlertOctagonIcon,
  "rate-limited": ZapOffIcon,
  degraded: AlertTriangleIcon,
  down: AlertOctagonIcon,
}
