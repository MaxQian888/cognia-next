"use client"

/**
 * Pet insight teaser — when a fresh Attention Radar report lands, nudge the
 * user with a one-line pet bubble (the report's `verdict`) inviting them to
 * open the radar panel in the pet console. Main-window only; the bubble mirrors
 * to the overlay via the cross-window bridge.
 *
 * We never tease a report that already existed when the hook mounted (a
 * baseline id is seeded first), so reloads don't re-fire an old insight.
 */

import { useEffect, useRef } from "react"
import { useLiveQuery } from "dexie-react-hooks"
import { getLatestRadarReport } from "@/lib/db/radar-reports"
import { sayAsPet } from "@/lib/pet/bubbles/say"
import { useSettingsStore } from "@/stores/settings"

export function usePetInsight(widgetEnabled: boolean): void {
  const radarEnabled = useSettingsStore((s) => Boolean(s.settings?.attentionRadar?.enabled))
  const enabled = widgetEnabled && radarEnabled

  const latest = useLiveQuery(() => getLatestRadarReport("self"), [])
  const seenRef = useRef<string | null>(null)
  const readyRef = useRef(false)

  // Seed the baseline once so a pre-existing report is never teased on mount.
  useEffect(() => {
    let cancelled = false
    void getLatestRadarReport("self").then((r) => {
      if (cancelled) return
      seenRef.current = r?.id ?? null
      readyRef.current = true
    })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (!enabled || !readyRef.current) return
    const id = latest?.id ?? null
    if (id && id !== seenRef.current) {
      seenRef.current = id
      const text = latest?.verdict?.trim() || latest?.atAGlance?.[0]?.trim() || ""
      // Through `sayAsPet` rather than straight into the store: a radar verdict
      // is model-derived text about what the user has been reading, so it takes
      // the PII gate and the shared speak budget like every other authored
      // line, and the bubble clears itself instead of sitting there until
      // something else happens to replace it.
      if (text) sayAsPet(text, { origin: "system" }, { muted: false })
    }
  }, [enabled, latest])
}
