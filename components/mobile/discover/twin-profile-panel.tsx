"use client"

/**
 * Mobile Twin profile viewer (Wave 2.5).
 *
 * Shows a quick read of the twin's distilled state — entity count, style
 * sample count, last update — so the user knows what the bound twin
 * "knows" before sending a message. The full profile is a projection
 * computed by the desktop; we fetch it through the new
 * `twin_profile_get` RPC.
 *
 * Reads happen on-mount and on `twinId` change; failures fall through
 * to a friendly empty state rather than blocking the page.
 */

import { useEffect, useState } from "react"
import { useTranslations } from "next-intl"

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { transport } from "@/lib/tauri"

interface TwinProfileSummary {
  twinId: string
  updatedAt?: number
  sampleCount?: number
  entityCount?: number
  styleSummary?: string
}

interface TwinProfileResponse {
  profile: TwinProfileSummary | null
}

export interface TwinProfilePanelProps {
  twinId: string
}

export function TwinProfilePanel({ twinId }: TwinProfilePanelProps) {
  const t = useTranslations("mobile.twinProfile")
  const [profile, setProfile] = useState<TwinProfileSummary | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  // React's "Adjusting State Based on Props": when twinId changes, drop
  // back to the loading state via a tracked key rather than syncing
  // through an effect (which the React compiler flags as "synchronous
  // setState within an effect can trigger cascading renders").
  const [lastTwinId, setLastTwinId] = useState(twinId)
  if (lastTwinId !== twinId) {
    setLastTwinId(twinId)
    setProfile(null)
    setError(null)
    setLoading(true)
  }

  useEffect(() => {
    let cancelled = false
    void transport
      .call("twin_profile_get", { twinId })
      .then((res: unknown) => {
        if (cancelled) return
        const profile = (res as TwinProfileResponse | null)?.profile ?? null
        setProfile(profile)
      })
      .catch((err) => {
        if (cancelled) return
        setError(err instanceof Error ? err.message : String(err))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [twinId])

  if (loading) {
    return <p className="text-sm text-muted-foreground">{t("loading")}</p>
  }
  if (error) {
    return <p className="text-sm text-destructive">{t("loadFailed", { message: error })}</p>
  }
  if (!profile) {
    return <p className="text-sm text-muted-foreground">{t("empty")}</p>
  }

  return (
    <Card data-testid="twin-profile-panel">
      <CardHeader>
        <CardTitle className="text-base">{t("title")}</CardTitle>
        <CardDescription>
          {profile.updatedAt
            ? t("updatedAt", { when: new Date(profile.updatedAt).toLocaleString() })
            : t("noUpdates")}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-2 text-sm">
        <Row label={t("samples")} value={String(profile.sampleCount ?? 0)} />
        <Row label={t("entities")} value={String(profile.entityCount ?? 0)} />
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

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="font-mono text-xs">{value}</span>
    </div>
  )
}
