"use client"

/**
 * Shared vocabulary for the Servers workspace: how a health state, an operation
 * state, a timestamp, and a byte count look wherever they appear.
 *
 * Health and operation state both carry a colour, and a fleet reads wrong if
 * the same state is one colour in the list and another in the detail — so the
 * mapping lives here once rather than being re-picked per component.
 */

import {
  CircleAlertIcon,
  CircleCheckIcon,
  CircleDashedIcon,
  CircleSlashIcon,
  LoaderCircleIcon,
  type LucideIcon,
} from "lucide-react"
import { useFormatter, useTranslations } from "next-intl"

import { Badge } from "@/components/ui/badge"
import type { OperationState, ServerHealth } from "@/lib/server-ops/client"
import { cn } from "@/lib/utils"

export const SERVER_HEALTHS: readonly ServerHealth[] = [
  "healthy",
  "degraded",
  "unavailable",
  "unknown",
]

const HEALTH_DOT: Record<ServerHealth, string> = {
  healthy: "bg-emerald-500",
  degraded: "bg-amber-500",
  unavailable: "bg-destructive",
  // Muted rather than a fourth hue: "we have not heard from it" is the absence
  // of a signal, not a fourth severity.
  unknown: "bg-muted-foreground/50",
}

const HEALTH_ICON: Record<ServerHealth, LucideIcon> = {
  healthy: CircleCheckIcon,
  degraded: CircleAlertIcon,
  unavailable: CircleSlashIcon,
  unknown: CircleDashedIcon,
}

const HEALTH_TEXT: Record<ServerHealth, string> = {
  healthy: "text-emerald-600 dark:text-emerald-400",
  degraded: "text-amber-600 dark:text-amber-400",
  unavailable: "text-destructive",
  unknown: "text-muted-foreground",
}

/** A state that is still moving; rendered with a spinner rather than a dot. */
const RUNNING_STATES: ReadonlySet<OperationState> = new Set([
  "queued",
  "validating",
  "preparing",
  "executing",
  "verifying",
])

const OPERATION_TONE: Record<OperationState, string> = {
  queued: "text-muted-foreground",
  validating: "text-muted-foreground",
  preparing: "text-muted-foreground",
  executing: "text-primary",
  verifying: "text-primary",
  succeeded: "text-emerald-600 dark:text-emerald-400",
  failed: "text-destructive",
  rolled_back: "text-amber-600 dark:text-amber-400",
  rollback_failed: "text-destructive",
  cancelled: "text-muted-foreground",
}

export function isRunningOperationState(state: OperationState): boolean {
  return RUNNING_STATES.has(state)
}

export function HealthDot({ health, className }: { health: ServerHealth; className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn("inline-block size-2 shrink-0 rounded-full", HEALTH_DOT[health], className)}
    />
  )
}

export function HealthLabel({ health, className }: { health: ServerHealth; className?: string }) {
  const t = useTranslations("servers")
  const Icon = HEALTH_ICON[health]
  return (
    <span
      className={cn("inline-flex items-center gap-1.5 text-xs", HEALTH_TEXT[health], className)}
    >
      <Icon className="size-3.5" aria-hidden="true" />
      {t(`health.${health}`)}
    </span>
  )
}

export function OperationStateBadge({ state }: { state: OperationState }) {
  const t = useTranslations("servers")
  return (
    <Badge variant="outline" className={cn("gap-1.5 font-normal", OPERATION_TONE[state])}>
      {isRunningOperationState(state) ? (
        <LoaderCircleIcon className="size-3 animate-spin" aria-hidden="true" />
      ) : (
        <span className="inline-block size-1.5 rounded-full bg-current" aria-hidden="true" />
      )}
      {t(`operationStates.${state}`)}
    </Badge>
  )
}

/**
 * Absolute timestamp. Uses `next-intl`'s formatter so the locale the app is
 * running in wins over the host's — the two diverge whenever a user picks a
 * language that is not their OS language.
 */
export function useAbsoluteTime(): (value: string | null | undefined) => string {
  const format = useFormatter()
  const t = useTranslations("servers")
  return (value) => {
    if (!value) return t("notAvailable")
    const parsed = new Date(value)
    if (Number.isNaN(parsed.getTime())) return t("notAvailable")
    return format.dateTime(parsed, { dateStyle: "medium", timeStyle: "short" })
  }
}

/**
 * "3 minutes ago" for a past instant.
 *
 * Rounds toward the coarser unit so a 59-second gap reads as "1 minute ago"
 * rather than flickering between seconds on every re-render.
 */
export function useRelativeTime(): (value: string | null | undefined) => string {
  const format = useFormatter()
  const t = useTranslations("servers")
  return (value) => {
    if (!value) return t("never")
    const parsed = new Date(value)
    if (Number.isNaN(parsed.getTime())) return t("never")
    return format.relativeTime(parsed)
  }
}

const BYTE_UNITS = ["B", "KiB", "MiB", "GiB", "TiB"] as const

/** Binary byte sizes — recovery points are reported by the agent in bytes. */
export function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value < 0) return "—"
  let size = value
  let unit = 0
  while (size >= 1024 && unit < BYTE_UNITS.length - 1) {
    size /= 1024
    unit += 1
  }
  return `${unit === 0 ? size : size.toFixed(1)} ${BYTE_UNITS[unit]}`
}

/**
 * Shorten an image digest for display.
 *
 * `sha256:` digests are 71 characters and identical in their first dozen, so a
 * plain truncation would render every release the same. Keeping the head and
 * the tail is what makes two digests distinguishable at a glance.
 */
export function shortenDigest(value: string | null | undefined): string | null {
  if (!value) return null
  const trimmed = value.trim()
  if (trimmed.length <= 24) return trimmed
  return `${trimmed.slice(0, 14)}…${trimmed.slice(-6)}`
}
