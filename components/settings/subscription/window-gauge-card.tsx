"use client"

// One quota-window gauge card: label + big percent + status word + colored
// bar + reset countdown. Shared by the Subscription Overview grid and the
// Usage tab's current-window section so the two surfaces render one visual
// language. Consumes a normalized `LimitsMeter` (see `resolveUsageWindows`).

import { useTranslations } from "next-intl"

import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"
import { useFlowMotion } from "@/components/chat/motion/motion-reveal"
import { useCountUp } from "@/hooks/usage/use-count-up"
import { useResetLabel } from "@/hooks/usage/use-reset-label"

import { QuotaBar } from "./quota-bar"

import type { LimitsMeter, LimitsMeterStatus } from "@/types/subscription"

const STATUS_TEXT: Record<LimitsMeterStatus, string> = {
  ok: "text-emerald-500",
  warn: "text-amber-500",
  crit: "text-destructive",
  exceeded: "text-destructive",
  unknown: "text-muted-foreground",
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

  // The bar animated over 500ms while the headline number it describes snapped
  // — two representations of one value moving at different speeds. `useCountUp`
  // is the same primitive the Usage tab's stat tiles already use; it honours the
  // app-wide reduced-motion preference through `useFlowMotion`.
  //
  // Tweens the *raw* percent, not the clamped one: the headline deliberately
  // reports overage (104%) while only the bar clamps at 100.
  const { reduce } = useFlowMotion()
  const displayPct = Math.round(useCountUp(rawPct ?? 0, { disabled: reduce, durationMs: 500 }))

  // Same phrasing as the Overview meters and the in-transcript /usage card:
  // a countdown while the reset is near, a weekday + clock time once it is a
  // day or more out. The weekly / opus / sonnet gauges here were the surface
  // still printing three-digit hour counts nobody could act on.
  const resetLabel = useResetLabel(meter.resetAt, now, {
    namespace: "subscription.usage.window",
  })
  const countdown = resetLabel ?? t("resetUnknown")

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
          {rawPct == null ? "—" : `${displayPct}%`}
        </span>
        {level && <span className="text-xs text-muted-foreground">{t(`level.${level}`)}</span>}
      </div>
      <QuotaBar pct={pct} status={meter.status} label={label} />
      <p className="text-xs text-muted-foreground">{countdown}</p>
    </div>
  )
}
