"use client"

/**
 * Canonical "edit a setting on the phone" helper (ADR-0056, decision D7).
 *
 * This used to do two steps: persist locally through `useSettingsStore.save`,
 * then enqueue an `app_settings_update` so a paired desktop applies the same
 * change. The enqueue now happens inside the one persistence funnel
 * (`lib/db/settings.ts:saveSettings` → `lib/settings/mirror-to-host.ts`), so it
 * must NOT be repeated here or every edit would queue twice.
 *
 * Moving it there is what fixed the mobile routes that embed a desktop settings
 * section — `/me/appearance` renders the desktop `<AppearanceSection />`, which
 * writes through the store directly and could never have called this hook.
 * Those edits stayed on the phone forever.
 *
 * The hook is kept because nine `/me/*` pages call it and it still names the
 * intent ("this is a settings edit from the phone") more clearly at the call
 * site than a bare store selector would.
 */

import { useCallback } from "react"

import type { AppSettings } from "@cognia/agent-config-types"
import { useSettingsStore } from "@/stores/settings"

export type SettingsPatchFn = (patch: Partial<AppSettings>) => Promise<void>

export function useSettingsPatch(): SettingsPatchFn {
  const save = useSettingsStore((s) => s.save)

  return useCallback(
    async (patch: Partial<AppSettings>) => {
      await save(patch as never)
    },
    [save]
  )
}
