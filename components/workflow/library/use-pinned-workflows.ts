"use client"

// Desktop pin/favorite for workflows. Reuses the SAME `pinnedWorkflowIds`
// field on the settings row that the mobile workflow list writes (see
// `components/mobile/workflow/workflow-list.tsx`), so a pin set on either
// surface shows on both. No new persistence.

import { useCallback, useMemo } from "react"
import { toast } from "sonner"
import { useTranslations } from "next-intl"
import { useSettingsStore } from "@/stores/settings/settings-store"

export function usePinnedWorkflows() {
  const t = useTranslations("workflows.card")
  const settings = useSettingsStore((s) => s.settings)
  const save = useSettingsStore((s) => s.save)
  // Stable identity so the toggle callback isn't rebuilt every render.
  const pinnedIds = useMemo(() => settings?.pinnedWorkflowIds ?? [], [settings])

  const isPinned = useCallback((id: string) => pinnedIds.includes(id), [pinnedIds])

  const togglePin = useCallback(
    async (id: string) => {
      const wasPinned = pinnedIds.includes(id)
      const next = wasPinned ? pinnedIds.filter((p) => p !== id) : [...pinnedIds, id]
      await save({ pinnedWorkflowIds: next })
      toast.success(wasPinned ? t("unpin") : t("pinned"))
    },
    [pinnedIds, save, t]
  )

  return { pinnedIds, isPinned, togglePin }
}
