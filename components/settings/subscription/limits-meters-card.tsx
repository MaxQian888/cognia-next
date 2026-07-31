"use client"

/**
 * Per-account unified limits/usage card for the Subscription → Usage tab.
 *
 * Renders the normalized `ProviderLimits` meters for one non-Anthropic account
 * via `useProviderLimits` — utilization windows (Codex 5h/weekly) as gauges with
 * reset countdowns, and credit/quota balances (Kimi, OpenCodeGo, DeepSeek, …) as
 * a remaining-amount gauge. This is the desktop sibling of the TUI `/limits`
 * panel; both consume the same abstraction so a new provider only needs a
 * `LimitsSource`, not new UI. Anthropic keeps its richer trend dashboard.
 *
 * All query + persistence logic lives in `useProviderLimits`; this file stays
 * presentational.
 */

import { useTranslations } from "next-intl"
import { GaugeIcon, RefreshCwIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { SettingsCard } from "@/components/settings/common/settings-section"
import { cn } from "@/lib/utils"
import { useFlowMotion } from "@/components/chat/motion/motion-reveal"
import { useCountUp } from "@/hooks/usage/use-count-up"
import { useProviderLimits } from "@/lib/subscription/limits/hooks"
import { splitCountdown } from "@/lib/subscription/anthropic/usage-analytics"

import { QuotaBar } from "./quota-bar"

import type { LimitsMeter, ProviderId } from "@/types/subscription"

export interface LimitsMetersCardProps {
  provider: ProviderId
  accountId: string
  /** Display label for the account (falls back to the id). */
  label?: string
  /** Render clock for reset countdowns (the tab ticks this once a minute). */
  now: number
  /**
   * Show only utilization-window meters (credit balances are rendered by the
   * sibling `BalanceCard`). When on and the account reports no windows, the
   * card renders nothing so credit-only providers don't show an empty shell.
   */
  windowsOnly?: boolean
}

function currencySymbol(currency?: string): string {
  if (currency === "CNY") return "¥"
  if (currency === "USD") return "$"
  return ""
}

function trimAmount(n: number): string {
  const s = n.toFixed(2)
  return s.endsWith(".00") ? s.slice(0, -3) : s
}

/** One normalized meter row (progress bar + figure + reset countdown). Exported
 *  so compact surfaces (e.g. the status-bar usage popover) render the exact same
 *  meter presentation instead of duplicating it. */
export function MeterRow({
  meter,
  accountId,
  now,
}: {
  meter: LimitsMeter
  accountId: string
  now: number
}) {
  const t = useTranslations("subscription.limits")
  const tr = useTranslations()

  const label =
    meter.labelKey && tr.has(meter.labelKey) ? tr(meter.labelKey) : (meter.label ?? meter.id)
  const pct = meter.usedPct == null ? null : Math.max(0, Math.min(100, Math.round(meter.usedPct)))
  const { reduce } = useFlowMotion()
  const displayPct = Math.round(useCountUp(pct ?? 0, { disabled: reduce, durationMs: 500 }))

  // Right-hand figure: "21% used" for windows, "¥88.50 left" for balances.
  let figure: string
  if (meter.kind === "window") {
    figure = t("percentUsed", { pct: displayPct })
  } else if (typeof meter.remaining === "number") {
    const sym = currencySymbol(meter.currency ?? meter.unit)
    const unit = sym ? "" : meter.unit ? ` ${meter.unit}` : ""
    figure = t("amountLeft", { amount: `${sym}${trimAmount(meter.remaining)}${unit}` })
  } else if (pct != null) {
    figure = t("percentUsed", { pct: displayPct })
  } else {
    figure = t("noValue")
  }

  const reset =
    meter.kind === "window" && meter.resetAt != null
      ? (() => {
          const parts = splitCountdown(meter.resetAt - now)
          if (parts.expired) return t("resetExpired")
          return parts.hours > 0
            ? t("resetsInHm", { hours: parts.hours, minutes: parts.minutes })
            : t("resetsInM", { minutes: parts.minutes })
        })()
      : null

  return (
    <div className="space-y-1" data-testid={`limits-meter-${accountId}-${meter.id}`}>
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-sm font-medium">{label}</span>
        <span className="text-xs tabular-nums text-muted-foreground">{figure}</span>
      </div>
      <QuotaBar pct={pct} status={meter.status} label={label} />
      {reset && <p className="text-xs text-muted-foreground">{reset}</p>}
    </div>
  )
}

export function LimitsMetersCard({
  provider,
  accountId,
  label,
  now,
  windowsOnly = false,
}: LimitsMetersCardProps) {
  const t = useTranslations("subscription.limits")
  const { snapshot, refreshing, unavailable, refresh } = useProviderLimits(provider, accountId)

  const meters = (snapshot?.meters ?? []).filter((m) => !windowsOnly || m.kind === "window")

  // In windows-only mode, stay invisible for credit-only / not-yet-fetched
  // accounts (the sibling BalanceCard owns those) — only surface once a real
  // utilization window or an error exists.
  if (windowsOnly && meters.length === 0 && !snapshot?.error) return null

  return (
    <SettingsCard
      icon={<GaugeIcon className="size-4" aria-hidden />}
      title={label || accountId}
      description={t("description")}
      headerAction={
        <Button
          variant="outline"
          size="sm"
          onClick={() => void refresh({ force: true })}
          disabled={refreshing}
          data-testid={`limits-refresh-${accountId}`}
          aria-label={t("refresh")}
        >
          <RefreshCwIcon className={cn("size-3.5", refreshing && "animate-spin")} aria-hidden />
          {t("refresh")}
        </Button>
      }
    >
      <div data-testid={`limits-card-${accountId}`} className="space-y-3">
        {snapshot?.error ? (
          <p className="text-xs text-destructive" data-testid={`limits-error-${accountId}`}>
            {t("error", { message: snapshot.error })}
          </p>
        ) : unavailable && !snapshot ? (
          <p
            className="text-xs text-muted-foreground"
            data-testid={`limits-unavailable-${accountId}`}
          >
            {t("unavailable")}
          </p>
        ) : !snapshot ? (
          <p className="text-xs text-muted-foreground" data-testid={`limits-empty-${accountId}`}>
            {t("empty")}
          </p>
        ) : meters.length === 0 ? (
          <p className="text-xs text-muted-foreground" data-testid={`limits-none-${accountId}`}>
            {t("noMeters")}
          </p>
        ) : (
          <div className="space-y-3">
            {meters.map((m) => (
              <MeterRow key={m.id} meter={m} accountId={accountId} now={now} />
            ))}
          </div>
        )}
        {snapshot && (
          <p
            className="text-[10px] text-muted-foreground"
            data-testid={`limits-fetched-${accountId}`}
          >
            {t("fetchedAt", { time: new Date(snapshot.fetchedAt).toLocaleString() })}
          </p>
        )}
      </div>
    </SettingsCard>
  )
}
