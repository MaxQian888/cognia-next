"use client"

import Link from "next/link"
import { useEffect, useState } from "react"
import { useTranslations } from "next-intl"

import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Badge } from "@/components/ui/badge"
import { loadCredential } from "@/lib/anthropic-subscription/credential-store"
import { isTauri } from "@/lib/tauri"
import type { SubscriptionCredential } from "@/lib/anthropic-subscription/types"
import { deterministicColor, initials } from "@/lib/ui/avatar"

export interface ProfileHeaderProps {
  /** Override credential loading — primarily for tests. */
  credentialLoader?: () => Promise<SubscriptionCredential | null>
}

export function ProfileHeader({ credentialLoader }: ProfileHeaderProps = {}) {
  const t = useTranslations("mobile.me.profile")
  const [credential, setCredential] = useState<SubscriptionCredential | null>(null)

  useEffect(() => {
    const loader =
      credentialLoader ?? (() => (isTauri() ? loadCredential() : Promise.resolve(null)))
    let cancelled = false
    loader()
      .then((c) => {
        if (!cancelled) setCredential(c)
      })
      .catch(() => {
        if (!cancelled) setCredential(null)
      })
    return () => {
      cancelled = true
    }
  }, [credentialLoader])

  const fallbackName = t("fallbackName")
  const fallbackPlan = t("fallbackPlan")

  const email = credential?.email ?? ""
  const displayName =
    credential?.email && credential.email.includes("@")
      ? credential.email.split("@")[0]
      : fallbackName
  const planLabel = credential?.plan ? credential.plan.toUpperCase() : fallbackPlan

  return (
    <Link
      href="/settings?section=subscription"
      data-testid="profile-header"
      className="flex items-center gap-3 rounded-md border border-border bg-card px-4 py-3 active:bg-muted/50"
      aria-label={t("manageAccount")}
    >
      <Avatar className="size-12">
        <AvatarFallback
          style={{ backgroundColor: deterministicColor(displayName) }}
          className="text-base"
        >
          {initials(displayName)}
        </AvatarFallback>
      </Avatar>
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-semibold" data-testid="profile-header-name">
            {displayName}
          </span>
          <Badge variant="outline" className="text-[10px]" data-testid="profile-header-plan">
            {planLabel}
          </Badge>
        </div>
        {email ? (
          <span
            className="truncate text-xs text-muted-foreground"
            data-testid="profile-header-email"
          >
            {email}
          </span>
        ) : null}
      </div>
    </Link>
  )
}
