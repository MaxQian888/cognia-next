"use client"

/**
 * Desktop Twin profile summary card for the Discover inspector.
 *
 * The mobile {@link TwinProfilePanel} reaches the profile through the
 * `twin_profile_get` companion RPC, which only exists on the mobile transport.
 * On desktop (and web) that RPC rejects, so this sibling reads the Dexie row
 * directly with `useLiveQuery` and projects it with the same shared
 * {@link summarizeTwinProfile} selector — identical output, different source.
 *
 * It reuses the existing `mobile.twinProfile.*` i18n namespace so there are no
 * duplicate keys.
 */

import { useTranslations } from "next-intl"
import { useLiveQuery } from "dexie-react-hooks"

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { getTwinProfile } from "@/lib/db/twin-profile"
import { summarizeTwinProfile } from "@/lib/twin/profile-summary"

const LOADING = "__loading__" as const

export interface TwinProfileCardProps {
  twinId: string
}

export function TwinProfileCard({ twinId }: TwinProfileCardProps) {
  const t = useTranslations("mobile.twinProfile")
  // Default to a sentinel so the first (undefined) tick is "loading", letting us
  // distinguish it from a genuinely missing row (resolved `undefined`).
  const row = useLiveQuery(() => getTwinProfile(twinId), [twinId], LOADING)

  if (row === LOADING) {
    return <p className="text-sm text-muted-foreground">{t("loading")}</p>
  }

  const profile = summarizeTwinProfile(row)
  if (!profile) {
    return <p className="text-sm text-muted-foreground">{t("empty")}</p>
  }

  return (
    <Card data-testid="twin-profile-card">
      <CardHeader>
        <CardTitle className="text-base">{t("title")}</CardTitle>
        <CardDescription>
          {profile.updatedAt
            ? t("updatedAt", { when: new Date(profile.updatedAt).toLocaleString() })
            : t("noUpdates")}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-2 text-sm">
        <p className="text-muted-foreground">{t("samples", { count: profile.sampleCount })}</p>
        <p className="text-muted-foreground">{t("entities", { count: profile.entityCount })}</p>
        {profile.styleSummary ? (
          <div className="space-y-1">
            <span className="text-xs font-medium text-muted-foreground">{t("style")}</span>
            <p className="rounded-md border bg-muted/40 p-2 text-xs">{profile.styleSummary}</p>
          </div>
        ) : null}
      </CardContent>
    </Card>
  )
}
