"use client"

/**
 * The account overview's line for a build without account sync: the feature
 * is dormant by build flag (`lib/account-sync/feature-flag.ts`), and the page
 * says so instead of omitting it silently. Renders null when the flag is on.
 */

import { useTranslations } from "next-intl"

import { accountSyncEnabled } from "@/lib/account-sync/feature-flag"

export function AccountSyncSummary() {
  const t = useTranslations("accountSync.summary")
  if (accountSyncEnabled()) return null
  return (
    <p
      className="text-xs text-muted-foreground"
      data-testid="account-sync-not-in-build"
      title={t("notInBuildHint")}
    >
      {t("notInBuild")}
    </p>
  )
}
