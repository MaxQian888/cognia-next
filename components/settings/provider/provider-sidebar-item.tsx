"use client"

import React, { useCallback } from "react"
import { useTranslations } from "next-intl"
import { Activity } from "lucide-react"
import { Button } from "@/components/ui/button"
import { hasBrandIcon } from "@/components/icons/brand-icon"
import { ProviderIcon } from "@/components/providers/ai/provider-icon"
import { cn } from "@/lib/utils"

export type ProviderConnectionStatus =
  | "connected"
  | "warning"
  | "not-configured"
  | "error"
  | "limited"
  /**
   * Credentials are present but no test has run yet. Its own state because
   * "configured, not yet verified" is the normal resting state of a freshly
   * added provider — painting it amber "warning" told the user something was
   * wrong when nothing was.
   */
  | "untested"

export type ProviderDiagnosticBadgeStatus = "passed" | "failed" | "stale"

interface ProviderSidebarItemProps {
  providerId: string
  name: string
  icon?: string | React.ReactNode
  subtitle: string
  status: ProviderConnectionStatus
  isSelected: boolean
  onClick: (providerId: string) => void
  modelCount?: number
  diagnosticStatus?: ProviderDiagnosticBadgeStatus
  tabIndex?: number
  onKeyDown?: React.KeyboardEventHandler<HTMLButtonElement>
}

/**
 * Per-status presentation. `labelKey` / `reasonKey` resolve under the
 * `providers.sidebar` namespace — the reason is surfaced as a native tooltip on
 * the status so a "warning"/"error" provider explains itself on hover and the
 * user knows the row is worth opening.
 *
 * A status is a coloured dot plus a short word, not a filled pill. Six pills
 * in six tints down a 320px rail were the loudest thing on the page, and
 * "Unconfigured" is the resting state of most rows, so the list was mostly
 * shouting about nothing. `dot` colours the marker, `text` the word.
 */
const STATUS_CONFIG: Record<
  ProviderConnectionStatus,
  {
    labelKey: string
    reasonKey: string
    dot: string
    text: string
  }
> = {
  connected: {
    labelKey: "statusConnected",
    reasonKey: "reasonConnected",
    dot: "bg-green-500",
    text: "text-green-700 dark:text-green-400",
  },
  warning: {
    labelKey: "statusWarning",
    reasonKey: "reasonWarning",
    dot: "bg-amber-500",
    text: "text-amber-700 dark:text-amber-400",
  },
  untested: {
    labelKey: "statusUntested",
    reasonKey: "reasonUntested",
    dot: "bg-muted-foreground/50",
    text: "text-muted-foreground",
  },
  "not-configured": {
    labelKey: "statusUnconfigured",
    reasonKey: "reasonUnconfigured",
    dot: "border border-muted-foreground/40 bg-transparent",
    text: "text-muted-foreground",
  },
  error: {
    labelKey: "statusError",
    reasonKey: "reasonError",
    dot: "bg-red-500",
    text: "text-red-700 dark:text-red-400",
  },
  // Verified but with caveats (e.g. authoritative verification wasn't
  // possible in this runtime) — distinct from a plain "connected" pass so
  // the sidebar marker doesn't overclaim.
  limited: {
    labelKey: "statusLimited",
    reasonKey: "reasonLimited",
    dot: "bg-amber-500",
    text: "text-amber-700 dark:text-amber-400",
  },
}

export const ProviderSidebarItem = React.memo(function ProviderSidebarItem({
  providerId,
  name,
  icon,
  subtitle,
  status,
  isSelected,
  onClick,
  modelCount,
  diagnosticStatus,
  tabIndex,
  onKeyDown,
}: ProviderSidebarItemProps) {
  const t = useTranslations("providers.sidebar")
  const handleClick = useCallback(() => onClick(providerId), [onClick, providerId])
  const statusCfg = STATUS_CONFIG[status]
  const statusLabel = t(statusCfg.labelKey)
  const statusReason = t(statusCfg.reasonKey)
  const branded = hasBrandIcon(providerId)

  return (
    <Button
      type="button"
      variant="ghost"
      id={`provider-${providerId}`}
      onClick={handleClick}
      onKeyDown={onKeyDown}
      tabIndex={tabIndex}
      role="option"
      aria-selected={isSelected}
      data-provider-row
      className={cn(
        // A selected row is tinted, not filled: a solid primary block hid the
        // brand icon and the status colours on the one row you were looking
        // at. The left bar carries the selection; the tint just keeps it
        // together.
        "relative h-auto w-full justify-start gap-2.5 whitespace-normal rounded-md px-2.5 py-2 text-left font-normal transition-colors",
        isSelected
          ? "bg-accent text-accent-foreground shadow-[inset_2px_0_0_0_var(--primary)]"
          : "hover:bg-muted/50"
      )}
    >
      {branded || icon == null ? (
        <ProviderIcon providerId={providerId} label={name} size={24} />
      ) : (
        <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-muted text-xs font-semibold">
          {icon}
        </div>
      )}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-sm font-medium">{name}</span>
          {modelCount !== undefined && modelCount > 0 && (
            <span
              className="shrink-0 text-[11px] tabular-nums text-muted-foreground"
              data-testid="provider-model-count"
            >
              {modelCount}
            </span>
          )}
          {diagnosticStatus && (
            <span
              data-testid="provider-diagnostic-badge"
              data-diagnostic-status={diagnosticStatus}
              title={t(
                `diagnostic${diagnosticStatus[0].toUpperCase()}${diagnosticStatus.slice(1)}`
              )}
              aria-label={t(
                `diagnostic${diagnosticStatus[0].toUpperCase()}${diagnosticStatus.slice(1)}`
              )}
              className={cn(
                "inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full",
                diagnosticStatus === "passed" && "bg-emerald-500/15 text-emerald-600",
                diagnosticStatus === "failed" && "bg-destructive/15 text-destructive",
                diagnosticStatus === "stale" && "bg-muted text-muted-foreground"
              )}
            >
              <Activity className="h-2.5 w-2.5" />
            </span>
          )}
        </div>
        <div className="truncate text-xs text-muted-foreground">{subtitle}</div>
      </div>
      <span
        data-status={status}
        title={statusReason}
        aria-label={`${statusLabel} — ${statusReason}`}
        className={cn(
          "inline-flex shrink-0 items-center gap-1.5 text-[11px] leading-none",
          statusCfg.text
        )}
      >
        <span aria-hidden className={cn("size-1.5 rounded-full", statusCfg.dot)} />
        <span className="hidden @[16rem]/provider-rail:inline">{statusLabel}</span>
      </span>
    </Button>
  )
})
