"use client"

/**
 * Per-account balance card for the Subscription → Usage tab.
 *
 * Renders the latest stored `BalanceSnapshot` for one non-Anthropic account
 * (codex / opencode / relay presets) — remaining / total with its currency or
 * unit, the last-fetched timestamp, an inline error state, and a manual
 * "Refresh" button. When no balance adapter matches the account's preset the
 * card shows an "unavailable" note instead.
 *
 * All query + persistence logic lives in `useAccountBalance`; this file stays
 * presentational.
 */

import { useTranslations } from "next-intl"
import { CoinsIcon, RefreshCwIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { SettingsCard } from "@/components/settings/common/settings-section"
import { cn } from "@/lib/utils"
import { useAccountBalance } from "@/lib/subscription/balance/hooks"

import type { ProviderId, SubscriptionBalanceRow } from "@/types/subscription"

export interface BalanceCardProps {
  provider: ProviderId
  accountId: string
  /** Whether this exact account has opted into outbound quota queries. */
  queryEnabled: boolean
  /** Display label for the account (falls back to the id). */
  label?: string
}

/** Format a balance amount with its currency / unit suffix. */
function formatAmount(value: number | undefined, snapshot: SubscriptionBalanceRow): string | null {
  if (value == null || !Number.isFinite(value)) return null
  const unit = snapshot.currency ?? snapshot.unit
  const rounded = value.toFixed(2)
  return unit ? `${rounded} ${unit}` : rounded
}

export function BalanceCard({ provider, accountId, queryEnabled, label }: BalanceCardProps) {
  const t = useTranslations("subscription.balance")
  const { snapshot, refreshing, unavailable, refresh } = useAccountBalance(
    provider,
    accountId,
    queryEnabled
  )

  const remaining = snapshot ? formatAmount(snapshot.remaining, snapshot) : null
  const total = snapshot ? formatAmount(snapshot.total, snapshot) : null
  const used = snapshot ? formatAmount(snapshot.used, snapshot) : null

  return (
    <SettingsCard
      icon={<CoinsIcon className="size-4" aria-hidden />}
      title={label || accountId}
      description={t("description")}
      headerAction={
        <Button
          variant="outline"
          size="sm"
          onClick={() => void refresh()}
          disabled={!queryEnabled || refreshing}
          data-testid={`balance-refresh-${accountId}`}
          aria-label={t("refresh")}
        >
          <RefreshCwIcon className={cn("size-3.5", refreshing && "animate-spin")} aria-hidden />
          {t("refresh")}
        </Button>
      }
    >
      <div data-testid={`balance-card-${accountId}`} className="space-y-2">
        {snapshot?.error ? (
          <p className="text-xs text-destructive" data-testid={`balance-error-${accountId}`}>
            {t("error", { message: snapshot.error })}
          </p>
        ) : unavailable && !snapshot ? (
          <p
            className="text-xs text-muted-foreground"
            data-testid={`balance-unavailable-${accountId}`}
          >
            {t("unavailable")}
          </p>
        ) : !snapshot ? (
          <p className="text-xs text-muted-foreground" data-testid={`balance-empty-${accountId}`}>
            {t("empty")}
          </p>
        ) : (
          <div className="space-y-1">
            <div className="flex items-baseline gap-2">
              <span
                className="text-2xl font-bold tabular-nums"
                data-testid={`balance-remaining-${accountId}`}
              >
                {remaining ?? t("noValue")}
              </span>
              <span className="text-xs text-muted-foreground">{t("remaining")}</span>
            </div>
            {total && (
              <p
                className="text-xs text-muted-foreground"
                data-testid={`balance-total-${accountId}`}
              >
                {t("total", { value: total })}
              </p>
            )}
            {used && (
              <p
                className="text-xs text-muted-foreground"
                data-testid={`balance-used-${accountId}`}
              >
                {t("used", { value: used })}
              </p>
            )}
          </div>
        )}
        {snapshot && (
          <p
            className="text-[10px] text-muted-foreground"
            data-testid={`balance-fetched-${accountId}`}
          >
            {t("fetchedAt", { time: new Date(snapshot.fetchedAt).toLocaleString() })}
          </p>
        )}
      </div>
    </SettingsCard>
  )
}
