/**
 * Unified adapter status — combines the master `enabled` flag with the live
 * health decision into a single coloured badge state, mirroring the AI
 * Provider page's connection-status badge language (green / amber / red /
 * grey). Shared by the Adapters list row and the detail-panel header so both
 * surfaces show the exact same status semantics.
 *
 * Reuses `decideBadge` (`@/components/inbox/adapter-health-decision`) for the
 * "loud when unhealthy" predicate — a disabled adapter is always grey
 * regardless of health; an enabled-and-nominal adapter is green; an enabled
 * adapter with a tripped health signal maps degraded/rate-limited → amber and
 * down/breaker-open → red. Non-healthy labels reuse the existing `rowHealth.*`
 * i18n keys so the wording stays consistent with the previous health badge.
 */

import {
  CheckIcon,
  AlertTriangleIcon,
  XCircleIcon,
  CircleIcon,
  type LucideIcon,
} from "lucide-react"

import { decideBadge, type BadgeState } from "@/components/inbox/adapter-health-decision"
import type { UseAdapterHealthResult } from "@/hooks/connectors/use-adapter-health"

export type AdapterStatus = "connected" | "warning" | "error" | "disabled"

export interface AdapterStatusInfo {
  status: AdapterStatus
  /** Badge className (border + bg + text), mirrors the Provider palette. */
  tint: string
  Icon: LucideIcon
  /** i18n key suffix under `settings.connections.adapters` for the label. */
  labelKey: string
}

const STATUS_TINT: Record<AdapterStatus, string> = {
  connected:
    "border-green-200 bg-green-50 text-green-700 dark:border-green-800 dark:bg-green-950 dark:text-green-400",
  warning:
    "border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-400",
  error:
    "border-red-200 bg-red-50 text-red-700 dark:border-red-800 dark:bg-red-950 dark:text-red-400",
  disabled: "border-muted-foreground/20 bg-muted/50 text-muted-foreground",
}

const STATUS_ICON: Record<AdapterStatus, LucideIcon> = {
  connected: CheckIcon,
  warning: AlertTriangleIcon,
  error: XCircleIcon,
  disabled: CircleIcon,
}

/** Map a health `BadgeState` to its `rowHealth.*` i18n key suffix. */
const HEALTH_LABEL_KEY: Record<BadgeState, string> = {
  "breaker-open": "rowHealth.breakerOpen",
  "rate-limited": "rowHealth.rateLimited",
  degraded: "rowHealth.degraded",
  down: "rowHealth.down",
}

/**
 * Resolve the unified status for an adapter from its `enabled` flag and the
 * live health hook result.
 */
export function deriveAdapterStatus(
  enabled: boolean,
  health: UseAdapterHealthResult
): AdapterStatusInfo {
  if (!enabled) {
    return {
      status: "disabled",
      tint: STATUS_TINT.disabled,
      Icon: STATUS_ICON.disabled,
      labelKey: "status.disabled",
    }
  }

  const decision = decideBadge(health)
  if (!decision) {
    return {
      status: "connected",
      tint: STATUS_TINT.connected,
      Icon: STATUS_ICON.connected,
      labelKey: "status.connected",
    }
  }

  const status: AdapterStatus =
    decision.state === "degraded" || decision.state === "rate-limited" ? "warning" : "error"

  return {
    status,
    tint: STATUS_TINT[status],
    Icon: STATUS_ICON[status],
    labelKey: HEALTH_LABEL_KEY[decision.state],
  }
}
