"use client"

// One quota-window gauge card: label + big percent + status word + colored
// bar + reset countdown. Shared by the Subscription Overview grid and the
// Usage tab's current-window section so the two surfaces render one visual
// language. Consumes a normalized `LimitsMeter` (see `resolveUsageWindows`).

import { useTranslations } from "next-intl"

import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"
import { splitCountdown } from "@/lib/subscription/anthropic/usage-analytics"

import type { LimitsMeter, LimitsMeterStatus } from "@/types/subscription"

const STATUS_TEXT: Record<LimitsMeterStatus, string> = {
  ok: "text-emerald-500",
  warn: "text-amber-500",
  crit: "text-destructive",
  exceeded: "text-destructive",
  unknown: "text-muted-foreground",
}

const STATUS_BAR: Record<LimitsMeterStatus, string> = {
  ok: "bg-emerald-500",
  warn: "bg-amber-500",
  crit: "bg-destructive",
  exceeded: "bg-destructive",
  unknown: "bg-muted-foreground",
}

/** Level word rendered next to the percent, keyed off the meter status. */
function levelKey(status: LimitsMeterStatus): "ok" | "warn" | "crit" | null {
  switch (status) {
    case "ok":
      return "ok"
    case "warn":
      return "warn"
    case "crit":
    case "exceeded":
      return "crit"
    default:
      return null
  }
}

export interface WindowGaugeCardProps {
  meter: LimitsMeter
  /** Render clock for the reset countdown (parents tick it periodically). */
  now: number
  /** Marks the window Anthropic reported as the binding constraint. */
  representative?: boolean
  testid?: string
}

export function WindowGaugeCard({ meter, now, representative, testid }: WindowGaugeCardProps) {
  const t = useTranslations("subscription.usage.window")
  const tr = useTranslations()

  const label =
    meter.labelKey && tr.has(meter.labelKey) ? tr(meter.labelKey) : (meter.label ?? meter.id)
  const rawPct = meter.usedPct
  const pct = rawPct == null ? null : Math.max(0, Math.min(100, Math.round(rawPct)))
  const level = levelKey(meter.status)

  const countdown =
    meter.resetAt == null
      ? t("resetUnknown")
      : (() => {
          const parts = splitCountdown(meter.resetAt - now)
          if (parts.expired) return t("resetExpired")
          return parts.hours > 0
            ? t("resetsInHm", { hours: parts.hours, minutes: parts.minutes })
            : t("resetsInM", { minutes: parts.minutes })
        })()

  return (
    <div className="space-y-2 rounded-lg border p-4" data-testid={testid}>
      <div className="flex items-center justify-between gap-2">
        <span className="truncate text-sm font-medium">{label}</span>
        {representative && (
          <Badge variant="outline" className="shrink-0 text-[10px]">
            {t("representative")}
          </Badge>
        )}
      </div>
      <div className="flex items-baseline gap-2">
        <span className={cn("text-2xl font-bold tabular-nums", STATUS_TEXT[meter.status])}>
          {rawPct == null ? "—" : `${Math.round(rawPct)}%`}
        </span>
        {level && <span className="text-xs text-muted-foreground">{t(`level.${level}`)}</span>}
      </div>
      <div
        className="h-2 w-full overflow-hidden rounded-full bg-muted"
        role="progressbar"
        aria-valuenow={pct ?? 0}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={label}
      >
        <div
          className={cn(
            "h-full rounded-full transition-all duration-500",
            STATUS_BAR[meter.status]
          )}
          style={{ width: `${pct ?? 0}%` }}
        />
      </div>
      <p className="text-xs text-muted-foreground">{countdown}</p>
    </div>
  )
}
