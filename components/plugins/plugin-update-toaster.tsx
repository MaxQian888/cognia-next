"use client"

/**
 * The listener for "notify only" auto-update.
 *
 * `PluginUpdater.runAutoUpdate` dispatches `plugin:updates-available` when the
 * configured cadence is notify-only, which is the default the Policy tab
 * presents. Nothing in the repo listened for that event, so the setting was a
 * promise the product never kept: updates were found, the flag was raised, and
 * the user was told nothing.
 *
 * Mounted at the app root, because the check runs on an interval regardless of
 * which page is open.
 */

import { useEffect, useRef } from "react"
import { useTranslations } from "next-intl"
import { useRouter } from "next/navigation"
import { toast } from "sonner"

import {
  PLUGIN_UPDATES_AVAILABLE_EVENT,
  type PluginUpdatesAvailableDetail,
} from "@/lib/plugin/lifecycle/updater"

/** One toast per set of ids inside this window, so an interval cannot nag. */
const DEDUPE_WINDOW_MS = 60_000

export function PluginUpdateToaster() {
  const t = useTranslations("plugins.update.updatesAvailable")
  const router = useRouter()
  const lastRef = useRef<{ key: string; at: number } | null>(null)

  useEffect(() => {
    if (typeof window === "undefined") return
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<PluginUpdatesAvailableDetail>).detail
      const updates = detail?.updates ?? []
      if (updates.length === 0) return

      const key = updates
        .map((u) => `${u.pluginId}@${u.latestVersion}`)
        .sort()
        .join(",")
      const now = Date.now()
      if (lastRef.current?.key === key && now - lastRef.current.at < DEDUPE_WINDOW_MS) return
      lastRef.current = { key, at: now }

      toast.message(t("title", { count: updates.length }), {
        description: t("description"),
        action: {
          label: t("review"),
          // Lands on the Library already narrowed to the rows that have one,
          // which is the sub-filter the sync path stamps `updateAvailable` for.
          onClick: () => router.push("/plugins?section=library&sub=updates"),
        },
      })
    }
    window.addEventListener(PLUGIN_UPDATES_AVAILABLE_EVENT, handler)
    return () => window.removeEventListener(PLUGIN_UPDATES_AVAILABLE_EVENT, handler)
  }, [t, router])

  return null
}
