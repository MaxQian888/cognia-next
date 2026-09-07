"use client"

/**
 * Mobile Twin profile viewer (Wave 2.5).
 *
 * Shows a quick read of the twin's distilled state — entity count, style
 * sample count, last update — so the user knows what the bound twin
 * "knows" before sending a message. The full profile is a projection
 * computed by the desktop; we fetch the raw row through the
 * `twin_profile_get` companion RPC and project it with the shared
 * {@link summarizeTwinProfile} selector (the same one the desktop card uses).
 *
 * Reads happen on-mount and on `twinId` change; failures fall through
 * to a friendly empty state rather than blocking the page.
 */

import { useEffect, useState } from "react"
import { useTranslations } from "next-intl"

import { MeSection } from "@/components/mobile/me/me-section"
import { transport } from "@/lib/tauri"
import { summarizeTwinProfile, type TwinProfileSummary } from "@/lib/twin/profile-summary"
import type { TwinProfile } from "@/types/twin"

interface TwinProfileResponse {
  profile: TwinProfile | null
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
        const raw = (res as TwinProfileResponse | null)?.profile ?? null
        setProfile(summarizeTwinProfile(raw))
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
    // A section, because the sources panel directly below it is one and this
    // was the only card on the tab. Two adjacent panels were speaking two
    // different layout languages.
    <MeSection
      testid="twin-profile-panel"
      title={t("title")}
      description={
        profile.updatedAt
          ? t("updatedAt", { when: new Date(profile.updatedAt).toLocaleString() })
          : t("noUpdates")
      }
    >
      <div className="flex flex-col gap-2 px-3 py-3 text-sm">
        <p className="text-muted-foreground">{t("samples", { count: profile.sampleCount })}</p>
        <p className="text-muted-foreground">{t("entities", { count: profile.entityCount })}</p>
        {profile.styleSummary ? (
          <div className="flex flex-col gap-1">
            <span className="text-xs font-medium text-muted-foreground">{t("style")}</span>
            <p className="rounded-md bg-muted/40 p-2 text-xs">{profile.styleSummary}</p>
          </div>
        ) : null}
      </div>
    </MeSection>
  )
}
