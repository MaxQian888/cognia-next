"use client"

// Anthropic Overview pane. Renders the live status badge, 5h/7d utilization
// bars, and the reset countdown for the ACTIVE Anthropic account. When the
// user is signed out we degrade to a CTA that opens the parent's add-account
// dialog. When the user is in web mode we show a banner explaining the
// keychain dependency.

import { useEffect, useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { CheckCircle2Icon, AlertTriangleIcon, BanIcon, ClockIcon } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import {
  SettingsAlert,
  SettingsCard,
  SettingsEmptyState,
} from "@/components/settings/common/settings-section"

import { useActiveAnthropicCredential, useAnthropicUsage } from "@/lib/subscription/anthropic/hooks"
import { isTauri } from "@/lib/tauri"
import { useSettingsStore } from "@/stores/settings/settings-store"
import {
  DEFAULT_ANTHROPIC_SUBSCRIPTION_SETTINGS,
  type AnthropicSubscriptionSettings,
  type UsageWindow,
} from "@/types/subscription"

function getSubscriptionSettings(
  appSettings: { subscriptionSettings?: AnthropicSubscriptionSettings } | null | undefined
): AnthropicSubscriptionSettings {
  return appSettings?.subscriptionSettings ?? DEFAULT_ANTHROPIC_SUBSCRIPTION_SETTINGS
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
  const { credential } = useActiveAnthropicCredential()
  const { latest } = useAnthropicUsage(20)
  const settings = useSettingsStore((s) => getSubscriptionSettings(s.settings))

  if (!tabReady) {
    return <SettingsAlert title={t("webModeBanner")}>{t("webModeBanner")}</SettingsAlert>
  }

  if (!credential) {
    return (
      <SettingsEmptyState
        title={t("overview.signedOutTitle")}
        description={t("overview.signedOutBody")}
        action={
          onRequestAddAccount ? (
            <Button onClick={onRequestAddAccount}>{t("overview.signInCta")}</Button>
          ) : undefined
        }
      />
    )
  }

  if (!latest) {
    return (
      <SettingsAlert title={t("overview.noSampleTitle")}>
        {t("overview.noSampleBody")}
      </SettingsAlert>
    )
  }

  return (
    <div className="space-y-3">
      <StatusCard latest={latest} />
      <UsageWindowCard
        title={t("overview.fiveHourTitle")}
        window={latest.fiveHour}
        isAuthoritative={latest.representativeClaim === "five_hour"}
        warnThresholdPct={settings.warnThresholdPct}
        authoritativeLabel={t("overview.authoritative")}
        warningLabel={t("overview.approachingLimit")}
        emptyLabel={t("overview.windowMissing")}
      />
      <UsageWindowCard
        title={t("overview.sevenDayTitle")}
        window={latest.sevenDay}
        isAuthoritative={latest.representativeClaim === "seven_day"}
        warnThresholdPct={settings.warnThresholdPct}
        authoritativeLabel={t("overview.authoritative")}
        warningLabel={t("overview.approachingLimit")}
        emptyLabel={t("overview.windowMissing")}
      />
    </div>
  )
}

function StatusCard({
  latest,
}: {
  latest: { status: string; fetchedAt: number; overageDisabledReason: string | null }
}) {
  const t = useTranslations("subscription")
  const ago = useRelativeTime(latest.fetchedAt)
  const tone =
    latest.status === "rate_limited"
      ? "destructive"
      : latest.status === "allowed_warning"
        ? "warning"
        : latest.status === "allowed"
          ? "success"
          : "muted"
  const Icon =
    tone === "destructive"
      ? BanIcon
      : tone === "warning"
        ? AlertTriangleIcon
        : tone === "success"
          ? CheckCircle2Icon
          : ClockIcon

  return (
    <SettingsCard
      title={t(`overview.status.${latest.status}`)}
      description={t("overview.statusFetched", { when: ago ?? "" })}
      icon={<Icon className="size-4" />}
      headerAction={
        latest.overageDisabledReason ? (
          <Badge variant="outline" className="text-[10px]">
            {latest.overageDisabledReason}
          </Badge>
        ) : null
      }
    >
      <></>
    </SettingsCard>
  )
}

function UsageWindowCard({
  title,
  window,
  isAuthoritative,
  warnThresholdPct,
  authoritativeLabel,
  warningLabel,
  emptyLabel,
}: {
  title: string
  window: UsageWindow | null
  isAuthoritative: boolean
  warnThresholdPct: number
  authoritativeLabel: string
  warningLabel: string
  emptyLabel: string
}) {
  const reset = useRelativeTime(window?.resetAt ?? null)
  if (!window) {
    return (
      <SettingsCard title={title} description={emptyLabel}>
        <></>
      </SettingsCard>
    )
  }
  const pct = Math.round(window.utilization * 100)
  const overWarn = pct >= warnThresholdPct
  return (
    <SettingsCard
      title={title}
      description={overWarn ? warningLabel : ""}
      headerAction={
        <div className="flex items-center gap-2">
          {isAuthoritative && (
            <Badge variant="default" className="text-[10px]">
              {authoritativeLabel}
            </Badge>
          )}
          <span className={`text-sm font-mono ${overWarn ? "text-destructive" : ""}`}>{pct}%</span>
        </div>
      }
    >
      <div className="space-y-2">
        <Progress value={pct} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} />
        <p className="text-xs text-muted-foreground">{reset ? `Resets ${reset}` : ""}</p>
      </div>
    </SettingsCard>
  )
}

function useRelativeTime(target: number | null): string | null {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const handle = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(handle)
  }, [])
  return useMemo(() => {
    if (target == null) return null
    const deltaSec = Math.round((target - now) / 1000)
    const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" })
    const absSec = Math.abs(deltaSec)
    if (absSec < 60) return formatter.format(deltaSec, "second")
    if (absSec < 3600) return formatter.format(Math.round(deltaSec / 60), "minute")
    if (absSec < 86_400) return formatter.format(Math.round(deltaSec / 3600), "hour")
    return formatter.format(Math.round(deltaSec / 86_400), "day")
  }, [target, now])
}
