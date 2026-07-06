"use client"

/**
 * Canonical "edit a setting on the phone" helper (ADR-0056, decision D7).
 *
 * Every mobile `/me/*` settings page repeated the same two steps: persist the
 * patch locally via `useSettingsStore.save` (so the UI updates immediately and
 * the standalone engine sees it), then enqueue an `app_settings_update` job so a
 * paired desktop applies the same change when online. This hook is that pattern
 * in one place.
 *
 * The enqueue is harmless when unpaired/standalone — the outbound runner simply
 * has nothing to drain until a desktop connects. The shared queue label lives in
 * the `mobile.settingsPanel` namespace, matching the original per-page call.
 */

import { useCallback } from "react"
import { useTranslations } from "next-intl"

import { enqueue } from "@/lib/db/mobile-outbound-queue"
import type { AppSettings } from "@/lib/claude/types"
import { useSettingsStore } from "@/stores/settings"

export type SettingsPatchFn = (patch: Partial<AppSettings>) => Promise<void>

export function useSettingsPatch(): SettingsPatchFn {
  const save = useSettingsStore((s) => s.save)
  const t = useTranslations("mobile.settingsPanel")

  return useCallback(
    async (patch: Partial<AppSettings>) => {
      await save(patch as never)
      const keys = Object.keys(patch ?? {}).join(", ")
      await enqueue({
        command: "app_settings_update",
        payload: { patch },
        label: t("queueLabel", { keys }),
      })
    },
    [save, t]
  )
}
