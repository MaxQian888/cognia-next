"use client"

/**
 * Desktop account overview — the unified identity surface desktop users get
 * in place of the mobile `/me` hub (the desktop `/me` route redirects here).
 * Aggregates the platform-neutral identity, the shared profile editor, and
 * jump-offs to the subscription + companion-devices sections.
 *
 * Reuses the same neutral hooks the mobile AccountCard sits on — but NOT the
 * mobile-coupled AccountCard component itself (it hard-links into `/me/*`).
 */

import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { useTranslations } from "next-intl"

import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Progress } from "@/components/ui/progress"
import { AccountManageDialog } from "@/components/account/account-manage-dialog"
import { deterministicColor, initials } from "@/lib/ui/avatar"
import { isTauri } from "@/lib/tauri"
import { useUserProfile } from "@/lib/profile/use-user-profile"
import { useActiveAnthropicCredential, useAnthropicUsage } from "@/lib/subscription/anthropic/hooks"
import { useCompanionConfig } from "@/hooks/companion/use-companion-config"
import { selectActiveAccount, useAccountStore } from "@/stores/account/account-store"

import { ProfileSection } from "../profile/profile-section"

function formatResetAt(resetAt: number | undefined): string | null {
  if (!resetAt) return null
  const delta = resetAt - Date.now()
  if (delta <= 0) return null
  const hours = Math.floor(delta / 3_600_000)
  const minutes = Math.floor((delta % 3_600_000) / 60_000)
  if (hours >= 24) return `${Math.floor(hours / 24)}d`
  if (hours >= 1) return `${hours}h ${minutes}m`
  return `${minutes}m`
}

function UsageRow({
  label,
  utilization,
  resetAt,
  resetLabel,
}: {
  label: string
  utilization: number | null
  resetAt: number | undefined
  resetLabel: string
}) {
  if (utilization === null) return null
  const pct = Math.round(Math.max(0, Math.min(1, utilization)) * 100)
  const reset = formatResetAt(resetAt)
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between text-[11px]">
        <span className="font-medium">{label}</span>
        <span className="text-muted-foreground">
          {pct}%{reset ? ` · ${resetLabel.replace("{remaining}", reset)}` : ""}
        </span>
      </div>
      <Progress value={pct} className="h-1.5" aria-label={label} />
    </div>
  )
}

export function AccountOverviewSection() {
  const t = useTranslations("settings.account")
  const router = useRouter()
  const { profile, resolvedDisplayName, resolvedAvatarUrl } = useUserProfile()
  const { credential } = useActiveAnthropicCredential()
  const { latest } = useAnthropicUsage(1)
  const { paired, shortDeviceId } = useCompanionConfig()
  const accountCount = useAccountStore((state) => state.accounts.length)
  const activeAccount = useAccountStore(selectActiveAccount)
  const [manageOpen, setManageOpen] = useState(false)
  // Local accounts are a Tauri-only concept; resolve post-hydration to keep the
  // server + first client render in agreement (mirrors settings-sidebar.tsx).
  const [desktopReady, setDesktopReady] = useState(false)
  useEffect(() => {
    const timer = setTimeout(() => setDesktopReady(isTauri()), 0)
    return () => clearTimeout(timer)
  }, [])

  const displayName = resolvedDisplayName ?? t("fallbackName")
  const email = credential?.email ?? ""
  const planLabel = credential?.plan ? credential.plan.toUpperCase() : t("fallbackPlan")
  const fiveHour = latest?.fiveHour ?? null
  const sevenDay = latest?.sevenDay ?? null

  return (
    <div className="space-y-6" data-testid="account-overview-section">
      <div className="space-y-1">
        <h2 className="text-base font-semibold">{t("title")}</h2>
        <p className="text-xs text-muted-foreground">{t("description")}</p>
      </div>

      <Card>
        <CardContent className="flex flex-col gap-4 pt-6">
          <div className="flex items-center gap-3">
            <Avatar className="size-14">
              {resolvedAvatarUrl ? (
                // eslint-disable-next-line @next/next/no-img-element -- avatar is a small data: URL, not an optimizable remote asset
                <img
                  src={resolvedAvatarUrl}
                  alt=""
                  className="size-full object-cover"
                  data-testid="account-overview-avatar-img"
                />
              ) : (
                <AvatarFallback style={{ backgroundColor: deterministicColor(displayName) }}>
                  {initials(displayName)}
                </AvatarFallback>
              )}
            </Avatar>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span
                  className="truncate text-sm font-semibold"
                  data-testid="account-overview-name"
                >
                  {displayName}
                </span>
                {profile.pronouns ? (
                  <span className="text-xs text-muted-foreground">{profile.pronouns}</span>
                ) : null}
                <Badge variant="outline" className="text-[10px]">
                  {planLabel}
                </Badge>
              </div>
              {email ? (
                <p
                  className="truncate text-xs text-muted-foreground"
                  data-testid="account-overview-email"
                >
                  {email}
                </p>
              ) : (
                <p className="text-xs text-muted-foreground">{t("notSignedIn")}</p>
              )}
              {profile.statusMessage ? (
                <p
                  className="truncate text-xs text-muted-foreground"
                  data-testid="account-overview-status"
                >
                  {profile.statusMessage}
                </p>
              ) : null}
            </div>
          </div>
          {fiveHour || sevenDay ? (
            <div className="flex flex-col gap-2 border-t pt-3">
              <UsageRow
                label={t("usageFiveHour")}
                utilization={fiveHour?.utilization ?? null}
                resetAt={fiveHour?.resetAt}
                resetLabel={t("usageReset")}
              />
              <UsageRow
                label={t("usageSevenDay")}
                utilization={sevenDay?.utilization ?? null}
                resetAt={sevenDay?.resetAt}
                resetLabel={t("usageReset")}
              />
            </div>
          ) : null}
        </CardContent>
      </Card>

      {desktopReady ? (
        <Card>
          <CardContent className="flex items-center justify-between gap-3 pt-6">
            <div className="min-w-0">
              <p className="text-sm font-medium">{t("localAccountsTitle")}</p>
              <p
                className="truncate text-xs text-muted-foreground"
                data-testid="account-overview-local-summary"
              >
                {t("localAccountsSummary", {
                  name: activeAccount?.displayName ?? t("fallbackName"),
                  count: accountCount,
                })}
              </p>
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setManageOpen(true)}
              data-testid="account-overview-manage-local"
            >
              {t("localAccountsManage")}
            </Button>
          </CardContent>
        </Card>
      ) : null}

      <ProfileSection />

      <Card>
        <CardContent className="flex items-center justify-between gap-3 pt-6">
          <div className="min-w-0">
            <p className="text-sm font-medium">{t("subscriptionTitle")}</p>
            <p className="truncate text-xs text-muted-foreground">{planLabel}</p>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => router.push("/settings?section=subscription")}
            data-testid="account-overview-manage-subscription"
          >
            {t("subscriptionManage")}
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="flex items-center justify-between gap-3 pt-6">
          <div className="min-w-0">
            <p className="text-sm font-medium">{t("devicesTitle")}</p>
            <p className="truncate text-xs text-muted-foreground">
              {paired && shortDeviceId
                ? t("devicePaired", { id: shortDeviceId })
                : t("deviceUnpaired")}
            </p>
          </div>
          {paired ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => router.push("/settings?section=companion")}
              data-testid="account-overview-manage-devices"
            >
              {t("devicesManage")}
            </Button>
          ) : (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => router.push("/pair")}
              data-testid="account-overview-pair"
            >
              {t("pair")}
            </Button>
          )}
        </CardContent>
      </Card>

      {desktopReady ? <AccountManageDialog open={manageOpen} onOpenChange={setManageOpen} /> : null}
    </div>
  )
}
