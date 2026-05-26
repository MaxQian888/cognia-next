"use client"

/**
 * Pin/favorite for `/me` rows. Mirrors `usePinnedWorkflows`
 * (`components/workflow/library/use-pinned-workflows.ts`) exactly — the pin
 * set lives on `settings.pinnedMeRowIds` and is written via the same
 * `useSettingsStore.save()` path, so there is no new persistence layer.
 */

import { useCallback, useMemo } from "react"
import { toast } from "sonner"
import { useTranslations } from "next-intl"

import { useSettingsStore } from "@/stores/settings/settings-store"

export function usePinnedMeRows() {
  const t = useTranslations("mobile.me")
  const settings = useSettingsStore((s) => s.settings)
  const save = useSettingsStore((s) => s.save)
  // Stable identity so the toggle callback isn't rebuilt every render.
  const pinnedIds = useMemo(() => settings?.pinnedMeRowIds ?? [], [settings])

  const isPinned = useCallback((id: string) => pinnedIds.includes(id), [pinnedIds])

  const togglePin = useCallback(
    async (id: string) => {
      const wasPinned = pinnedIds.includes(id)
      const next = wasPinned ? pinnedIds.filter((p) => p !== id) : [...pinnedIds, id]
      await save({ pinnedMeRowIds: next })
      toast.success(wasPinned ? t("unpinned") : t("pinned"))
    },
    [pinnedIds, save, t]
  )

  return { pinnedIds, isPinned, togglePin }
}
