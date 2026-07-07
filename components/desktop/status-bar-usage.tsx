"use client"

/**
 * Status-bar usage/limits segment. Reuses the aggregated limits hook
 * (`useAllConfiguredLimits`) — refreshed on mount and whenever the subscription
 * event bus fires — and surfaces the single worst-utilized meter as a compact
 * "NN%" chip. The popover renders every account's meters via the shared
 * `MeterRow` (same presentation as the Subscription → Usage tab) and links out
 * to that settings section. Desktop-only: on web the hook stays empty, so the
 * chip returns `null`.
 */

import { useEffect } from "react"
import { useTranslations } from "next-intl"
import { GaugeIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { cn } from "@/lib/utils"
import { MeterRow } from "@/components/settings/subscription/limits-meters-card"
import { subscribeSubscriptionChanged } from "@/lib/subscription/core/subscription-events"
import { useAllConfiguredLimits } from "@/lib/subscription/limits/hooks"
import { useUIStore } from "@/stores/ui/ui-store"
import type { LimitsMeter, LimitsMeterStatus } from "@/types/subscription"

const STATUS_TEXT: Record<LimitsMeterStatus, string> = {
  ok: "text-emerald-500",
  warn: "text-amber-500",
  crit: "text-rose-500",
  exceeded: "text-rose-500",
  unknown: "text-muted-foreground",
}

export function StatusBarUsage() {
  const t = useTranslations("desktop.statusBar")
  const requestOpenSettings = useUIStore((s) => s.requestOpenSettings)
  const { snapshots, refresh } = useAllConfiguredLimits()

  useEffect(() => {
    void refresh()
    return subscribeSubscriptionChanged(() => void refresh())
  }, [refresh])

  const allMeters = snapshots.flatMap((s) => s.meters)
  if (allMeters.length === 0) return null

  // Single pass: track the highest-utilized meter (and its numeric pct) so we
  // never depend on `LimitsMeter.usedPct` being narrowed — the source type is
  // `number | null`, which would otherwise leave dead `?? 0` fallbacks.
  let worstMeter: LimitsMeter | null = null
  let worstPct = -1
  for (const meter of allMeters) {
    const p = meter.usedPct
    if (p == null) continue
    if (p > worstPct) {
      worstPct = p
      worstMeter = meter
    }
  }
  const pct = worstPct >= 0 ? Math.max(0, Math.min(100, Math.round(worstPct))) : null
  const status: LimitsMeterStatus = worstMeter?.status ?? "unknown"
  const pctText = pct == null ? null : `${pct}%`

  // Clock for the reset countdowns rendered inside MeterRow. Computed at render
  // for the popover; a slightly stale value only affects a countdown label.
  // eslint-disable-next-line react-hooks/purity
  const now = Date.now()

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-testid="status-usage"
          aria-label={t("usage")}
          title={t("usage")}
          className="flex h-6 shrink-0 items-center gap-1 px-2 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <GaugeIcon aria-hidden className={cn("size-3", STATUS_TEXT[status])} />
          {pctText && <span className="tabular-nums">{pctText}</span>}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" sideOffset={4} className="w-72 space-y-3 p-3">
        {snapshots.map((s) => (
          <div key={`${s.provider}-${s.accountId ?? "x"}`} className="space-y-2">
            {s.accountLabel && (
              <p className="text-xs font-medium text-muted-foreground">{s.accountLabel}</p>
            )}
            {s.meters.map((meter) => (
              <MeterRow
                key={meter.id}
                meter={meter}
                accountId={s.accountId ?? s.provider}
                now={now}
              />
            ))}
          </div>
        ))}
        <Button
          variant="outline"
          size="sm"
          className="w-full"
          data-testid="status-usage-open"
          onClick={() => requestOpenSettings("subscription")}
        >
          {t("usageOpen")}
        </Button>
      </PopoverContent>
    </Popover>
  )
}
