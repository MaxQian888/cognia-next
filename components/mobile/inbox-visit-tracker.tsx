"use client"

/**
 * Inbox visit tracker (mobile).
 *
 * Mounted from `app/inbox/layout.tsx`; bumps `settings.lastInboxViewedAt`
 * to `Date.now()` once on mount so the bottom Tab Bar's Chat-tab unread
 * badge clears as soon as the user opens any /inbox/* route.
 *
 * Renders nothing.
 */

import { useEffect } from "react"

import { useSettingsStore } from "@/stores/settings"

export function InboxVisitTracker() {
  const save = useSettingsStore((s) => s.save)
  useEffect(() => {
    void save({ lastInboxViewedAt: Date.now() })
  }, [save])
  return null
}
