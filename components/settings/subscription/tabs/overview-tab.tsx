"use client"

// Anthropic Overview pane.
//
// Quota windows come from TWO fused sources (see `resolveUsageWindows`): the
// free OAuth usage endpoint (fetched on demand — no chat traffic required) and
// the passive rate-limit header samples. The pane auto-fetches on mount when
// the data is missing or stale, offers a manual refresh, and lays the window
// gauges out in a container-responsive grid. Signed-out → CTA that opens the
// parent's add-account dialog; web mode → keychain-dependency banner.

import { useEffect, useMemo, useRef } from "react"
import { useSubscriptionNow } from "@/lib/subscription/core/now-ticker"
import { useTranslations } from "next-intl"
import {
  AlertTriangleIcon,
  BanIcon,
  CheckCircle2Icon,
  ClockIcon,
  RefreshCwIcon,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { SettingsAlert, SettingsEmptyState } from "@/components/settings/common/settings-section"
import { PanelTransition } from "@/components/settings/common/panel-transition"
import { WindowGaugeCard } from "@/components/settings/subscription/window-gauge-card"
import { MeterRow } from "@/components/settings/subscription/limits-meters-card"
import { cn } from "@/lib/utils"

import { useActiveAnthropicCredential, useAnthropicUsage } from "@/lib/subscription/anthropic/hooks"
import {
  resolveUsageWindows,
  usageStatusFor,
  usageWindowsStale,
} from "@/lib/subscription/anthropic/overview-windows"
import { useProviderLimits } from "@/lib/subscription/limits/hooks"
import { isTauri } from "@/lib/tauri"
import { useSettingsStore } from "@/stores/settings/settings-store"
import {
  DEFAULT_ANTHROPIC_SUBSCRIPTION_SETTINGS,
  type AnthropicSubscriptionSettings,
  type UsageStatus,
} from "@/types/subscription"

function getSubscriptionSettings(
  appSettings: { subscriptionSettings?: AnthropicSubscriptionSettings } | null | undefined
): AnthropicSubscriptionSettings {
  return appSettings?.subscriptionSettings ?? DEFAULT_ANTHROPIC_SUBSCRIPTION_SETTINGS
}

const STATUS_ICON: Record<UsageStatus, { icon: typeof ClockIcon; className: string }> = {
  allowed: { icon: CheckCircle2Icon, className: "text-emerald-500" },
  allowed_warning: { icon: AlertTriangleIcon, className: "text-amber-500" },
  rate_limited: { icon: BanIcon, className: "text-destructive" },
  unknown: { icon: ClockIcon, className: "text-muted-foreground" },
}

export interface SubscriptionOverviewTabProps {
  /** Called when the empty-state CTA is clicked. */
  onRequestAddAccount?: () => void
}

export function SubscriptionOverviewTab({
  onRequestAddAccount,
}: SubscriptionOverviewTabProps = {}) {
  const t = useTranslations("subscription")
  const tabReady = isTauri()
  const { credential, activeAccountId } = useActiveAnthropicCredential()
  const { latest } = useAnthropicUsage(20)
  const settings = useSettingsStore((s) => getSubscriptionSettings(s.settings))
  const { snapshot, refreshing, queryEnabled, setQueryEnabled, refresh } = useProviderLimits(
    "anthropic",
    activeAccountId ?? ""
  )

  const now = useSubscriptionNow()

  const resolved = useMemo(
    () => resolveUsageWindows(snapshot, latest, { warnThresholdPct: settings.warnThresholdPct }),
    [snapshot, latest, settings.warnThresholdPct]
  )

  // Auto-fetch once per (mount, account) when the fused data is missing or
  // stale — the free endpoint costs nothing, so first paint shouldn't wait for
  // chat traffic. Manual refresh stays available either way.
  const autoFetchedForRef = useRef<string | null>(null)
  useEffect(() => {
    if (!tabReady || !credential || !activeAccountId || !queryEnabled) return
    if (autoFetchedForRef.current === activeAccountId) return
    if (!usageWindowsStale(resolved, now)) return
    autoFetchedForRef.current = activeAccountId
    void refresh()
  }, [tabReady, credential, activeAccountId, resolved, now, queryEnabled, refresh])

  // The pane has four mutually exclusive full-subtree states. They used to
  // replace each other instantly; `PanelTransition` crossfades them, keyed on
  // which branch is showing (it collapses to a plain wrapper under reduced
  // motion). `branch` is also what distinguishes a first load in flight from a
  // genuinely empty account — previously both rendered the same "no data" block
  // and the only tell was a spinner buried in its action button.
  const firstLoad = resolved.windows.length === 0 && refreshing && !snapshot?.error
  const branch = !tabReady
    ? "web"
    : !credential
      ? "signedOut"
      : firstLoad
        ? "loading"
        : resolved.windows.length === 0
          ? "empty"
          : "ready"

  if (branch !== "ready") {
    return (
      <PanelTransition activeKey={branch}>
        {branch === "web" ? (
          <SettingsAlert title={t("webModeBanner")}>{t("webModeBanner")}</SettingsAlert>
        ) : branch === "signedOut" ? (
          <SettingsEmptyState
            title={t("overview.signedOutTitle")}
            description={t("overview.signedOutBody")}
            action={
              onRequestAddAccount ? (
                <Button onClick={onRequestAddAccount}>{t("overview.signInCta")}</Button>
              ) : undefined
            }
          />
        ) : branch === "loading" ? (
          <OverviewSkeleton label={t("overview.loading")} />
        ) : (
          <SettingsEmptyState
            title={
              queryEnabled ? t("overview.noDataTitle") : t("overview.officialQuotaDisabledTitle")
            }
            // A failed query is not "no data yet": show why (expired bearer,
            // throttle, outage) rather than the generic empty copy, which is what
            // made a broken quota read indistinguishable from an idle account.
            description={
              !queryEnabled
                ? t("overview.officialQuotaDisabledBody")
                : snapshot?.error
                  ? t("limits.error", { message: snapshot.error })
                  : t("overview.noDataBody")
            }
            action={
              <Button
                onClick={() =>
                  void (queryEnabled ? refresh({ force: true }) : setQueryEnabled(true))
                }
                disabled={refreshing}
                data-testid="overview-refresh"
              >
                <RefreshCwIcon className={cn("mr-2 size-4", refreshing && "animate-spin")} />
                {queryEnabled ? t("overview.refresh") : t("limits.query.enable")}
              </Button>
            }
          />
        )}
      </PanelTransition>
    )
  }

  const status = usageStatusFor(resolved)
  const { icon: StatusIcon, className: statusClass } = STATUS_ICON[status]
  const updatedAgo = formatRelative(resolved.fetchedAt, now)
  const sourceLabel =
    resolved.source === "endpoint" ? t("overview.sourceEndpoint") : t("overview.sourceHeaders")

  return (
    <div className="@container space-y-3" data-testid="overview-windows">
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border px-4 py-3">
        <div className="flex min-w-0 items-center gap-3">
          <StatusIcon className={cn("size-5 shrink-0", statusClass)} aria-hidden />
          <div className="min-w-0">
            <div className="text-sm font-medium" data-testid="overview-status">
              {t(`overview.status.${status}`)}
            </div>
            <div className="truncate text-xs text-muted-foreground">
              {updatedAgo ? t("overview.updated", { when: updatedAgo }) : ""}
              {updatedAgo ? " · " : ""}
              {sourceLabel}
            </div>
          </div>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => void refresh({ force: true })}
          disabled={refreshing || !queryEnabled}
          data-testid="overview-refresh"
          aria-label={t("overview.refresh")}
        >
          <RefreshCwIcon className={cn("size-3.5", refreshing && "animate-spin")} aria-hidden />
          {t("overview.refresh")}
        </Button>
      </div>

      <div className="grid gap-3 @lg:grid-cols-2">
        {resolved.windows.map((meter) => (
          <WindowGaugeCard
            key={meter.id}
            meter={meter}
            now={now}
            representative={
              (meter.id === "session" && resolved.representativeClaim === "five_hour") ||
              (meter.id === "weekly" && resolved.representativeClaim === "seven_day")
            }
            testid={`overview-window-${meter.id}`}
          />
        ))}
      </div>

      {resolved.extras.length > 0 && (
        <div className="space-y-3 rounded-lg border p-4" data-testid="overview-extras">
          {resolved.extras.map((meter) => (
            <MeterRow
              key={meter.id}
              meter={meter}
              accountId={activeAccountId ?? "active"}
              now={now}
            />
          ))}
        </div>
      )}

      {resolved.overageDisabledReason && (
        <SettingsAlert variant="destructive">
          {t("usage.window.overageDisabled", { reason: resolved.overageDisabledReason })}
        </SettingsAlert>
      )}
    </div>
  )
}

/** Compact relative time ("3 minutes ago"), `null` when the input is absent. */
/**
 * First-load placeholder, shaped like the status strip + gauge grid it precedes.
 * Without it a pending quota fetch rendered the identical "no data" empty state,
 * so an account that was merely still loading was indistinguishable from one
 * with nothing to show.
 */
function OverviewSkeleton({ label }: { label: string }) {
  return (
    <div className="@container space-y-3" aria-busy="true" aria-label={label}>
      <Skeleton className="h-[68px] w-full rounded-lg" />
      <div className="grid grid-cols-1 gap-3 @lg:grid-cols-2">
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-[124px] w-full rounded-lg" />
        ))}
      </div>
    </div>
  )
}

function formatRelative(target: number | null, now: number): string | null {
  if (target == null) return null
  const deltaSec = Math.round((target - now) / 1000)
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" })
  const absSec = Math.abs(deltaSec)
  if (absSec < 60) return formatter.format(deltaSec, "second")
  if (absSec < 3600) return formatter.format(Math.round(deltaSec / 60), "minute")
  if (absSec < 86_400) return formatter.format(Math.round(deltaSec / 3600), "hour")
  return formatter.format(Math.round(deltaSec / 86_400), "day")
}
