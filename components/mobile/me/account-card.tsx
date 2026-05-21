"use client"

/**
 * Live identity card for the mobile profile screen. Replaces the legacy
 * `<ProfileHeader />` (one-shot loader, no usage data, broken
 * deep-link).
 *
 * - Subscribes to `useActiveAnthropicCredential()` so plan / email
 *   updates appear without a manual reload.
 * - Pulls 5h / 7d utilisation from `useAnthropicUsage()` and renders
 *   them as Progress bars with reset-time hints.
 * - Click anywhere on the card → `/me/subscription` (mobile sub-page
 *   that wraps the desktop SubscriptionSection).
 */

import Link from "next/link"
import { useTranslations } from "next-intl"

import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent } from "@/components/ui/card"
import { Progress } from "@/components/ui/progress"
import { Skeleton } from "@/components/ui/skeleton"
import { cn } from "@/lib/utils"
import { useActiveAnthropicCredential, useAnthropicUsage } from "@/lib/subscription/anthropic/hooks"
import { deterministicColor, initials } from "@/lib/ui/avatar"

function formatResetAt(resetAt: number | undefined): string | null {
  if (!resetAt) return null
  const now = Date.now()
  const delta = resetAt - now
  if (delta <= 0) return null
  const hours = Math.floor(delta / 3_600_000)
  const minutes = Math.floor((delta % 3_600_000) / 60_000)
  if (hours >= 24) {
    const days = Math.floor(hours / 24)
    return `${days}d`
  }
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
          {pct}% · {reset ? resetLabel.replace("{remaining}", reset) : ""}
        </span>
      </div>
      <Progress value={pct} className="h-1.5" aria-label={label} />
    </div>
  )
}

export function AccountCard({ className }: { className?: string }) {
  const t = useTranslations("mobile.me.account")
  const tProfile = useTranslations("mobile.me.profile")
  const { credential, loading } = useActiveAnthropicCredential()
  const { latest } = useAnthropicUsage(1)

  const fallbackName = tProfile("fallbackName")
  const fallbackPlan = tProfile("fallbackPlan")

  const email = credential?.email ?? ""
  const displayName =
    credential?.email && credential.email.includes("@")
      ? credential.email.split("@")[0]
      : fallbackName
  const planLabel = credential?.plan ? credential.plan.toUpperCase() : fallbackPlan

  const fiveHour = latest?.fiveHour ?? null
  const sevenDay = latest?.sevenDay ?? null

  return (
    <Link
      href="/me/subscription"
      data-testid="account-card"
      aria-label={tProfile("manageAccount")}
      className={cn("block", className)}
    >
      <Card className="px-3 py-3 transition-colors active:bg-muted/50">
        <CardContent className="flex flex-col gap-3 p-0">
          <div className="flex items-center gap-3">
            <Avatar className="size-12">
              <AvatarFallback
                style={{ backgroundColor: deterministicColor(displayName) }}
                className="text-base"
              >
                {initials(displayName)}
              </AvatarFallback>
            </Avatar>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="truncate text-sm font-semibold" data-testid="account-card-name">
                  {displayName}
                </span>
                <Badge variant="outline" className="text-[10px]" data-testid="account-card-plan">
                  {planLabel}
                </Badge>
              </div>
              {loading ? (
                <Skeleton className="mt-1 h-3 w-32" />
              ) : email ? (
                <p
                  className="truncate text-xs text-muted-foreground"
                  data-testid="account-card-email"
                >
                  {email}
                </p>
              ) : (
                <p className="text-xs text-muted-foreground">{t("notSignedIn")}</p>
              )}
            </div>
          </div>
          {(fiveHour || sevenDay) && (
            <div className="flex flex-col gap-2 border-t pt-2">
              <UsageRow
                label={t("fiveHourLabel")}
                utilization={fiveHour?.utilization ?? null}
                resetAt={fiveHour?.resetAt}
                resetLabel={t("resetIn")}
              />
              <UsageRow
                label={t("sevenDayLabel")}
                utilization={sevenDay?.utilization ?? null}
                resetAt={sevenDay?.resetAt}
                resetLabel={t("resetIn")}
              />
            </div>
          )}
        </CardContent>
      </Card>
    </Link>
  )
}
