"use client"

import Link from "next/link"
import { useEffect, useState } from "react"
import { useTranslations } from "next-intl"

import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Badge } from "@/components/ui/badge"
import { Item, ItemContent, ItemDescription, ItemMedia, ItemTitle } from "@/components/ui/item"
import { getAccount, getActiveAccount } from "@/lib/subscription/core/transport"
import { isTauri } from "@/lib/tauri"
import type { AnthropicCredentialData } from "@/lib/subscription/core/types"
import { deterministicColor, initials } from "@/lib/ui/avatar"

export interface ProfileHeaderProps {
  /** Override credential loading — primarily for tests. */
  credentialLoader?: () => Promise<AnthropicCredentialData | null>
}

async function loadActiveAnthropicCredential(): Promise<AnthropicCredentialData | null> {
  if (!isTauri()) return null
  const snapshot = await getActiveAccount("anthropic")
  if (!snapshot.activeAccountId) return null
  const account = await getAccount("anthropic", snapshot.activeAccountId)
  if (!account || account.credential.provider !== "anthropic") return null
  return {
    accessToken: account.credential.accessToken,
    refreshToken: account.credential.refreshToken,
    expiresAtMs: account.credential.expiresAtMs,
    mode: account.credential.mode,
    scope: account.credential.scope,
    email: account.credential.email,
    plan: account.credential.plan,
    storedAtMs: account.credential.storedAtMs,
  }
}

export function ProfileHeader({ credentialLoader }: ProfileHeaderProps = {}) {
  const t = useTranslations("mobile.me.profile")
  const [credential, setCredential] = useState<AnthropicCredentialData | null>(null)

  useEffect(() => {
    const loader = credentialLoader ?? loadActiveAnthropicCredential
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
      className="block"
      aria-label={t("manageAccount")}
    >
      <Item
        variant="outline"
        size="sm"
        className="flex-nowrap bg-card px-4 py-3 transition-colors active:bg-muted/50"
      >
        <ItemMedia variant="image" className="size-12">
          <Avatar className="size-12">
            <AvatarFallback
              style={{ backgroundColor: deterministicColor(displayName) }}
              className="text-base"
            >
              {initials(displayName)}
            </AvatarFallback>
          </Avatar>
        </ItemMedia>
        <ItemContent>
          <ItemTitle className="flex items-center gap-2 text-sm">
            <span className="truncate" data-testid="profile-header-name">
              {displayName}
            </span>
            <Badge variant="outline" className="text-[10px]" data-testid="profile-header-plan">
              {planLabel}
            </Badge>
          </ItemTitle>
          {email ? (
            <ItemDescription className="text-xs" data-testid="profile-header-email">
              {email}
            </ItemDescription>
          ) : null}
        </ItemContent>
      </Item>
    </Link>
  )
}
