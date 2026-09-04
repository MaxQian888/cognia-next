"use client"

import { useSyncExternalStore } from "react"
import { useTranslations } from "next-intl"

import { Badge } from "@/components/ui/badge"
import { getActiveAccountId } from "@/lib/accounts/active-account-id"
import {
  getCollabRefreshState,
  isCollabRefreshStale,
  subscribeCollabRefreshState,
} from "@/lib/collab/refresh-scheduler"

export function CollabRefreshStaleBadge() {
  const t = useTranslations("issues.freshness")
  const localAccountId = getActiveAccountId()
  useSyncExternalStore(
    subscribeCollabRefreshState,
    () => getCollabRefreshState(localAccountId),
    () => getCollabRefreshState(localAccountId)
  )
  if (!isCollabRefreshStale(localAccountId)) return null
  return (
    <Badge variant="outline" className="border-amber-500/60" data-testid="collab-refresh-stale">
      {t("stale")}
    </Badge>
  )
}
