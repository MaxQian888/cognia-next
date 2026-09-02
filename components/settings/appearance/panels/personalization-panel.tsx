"use client"

// The Personalization panel: who the app thinks you are, and what it shows
// while it is not letting you in.
//
// The lock screen lives here rather than under Wallpaper because it is not a
// wallpaper setting. It has its own backdrop, its own blur and its own dim,
// and it can deliberately differ from what the app shows once unlocked.

import { useMemo } from "react"

import { useSettingsStore } from "@/stores/settings"
import { withBuiltinPresets } from "@/lib/appearance"
import { DEFAULT_LOCK_SCREEN, type LockScreenSettings } from "@/types/appearance/lock-screen"
import { PersonalizationCard } from "../../personalization-card"
import { LockScreenCard } from "../components/lock-screen-card"

export function PersonalizationPanel() {
  const wallpapers = useSettingsStore((state) => state.wallpapers)
  const lockScreen = useSettingsStore((state) => state.lockScreen)
  const setLockScreen = useSettingsStore((state) => state.setLockScreen)

  const gallery = useMemo(() => withBuiltinPresets(wallpapers), [wallpapers])
  const settings: LockScreenSettings = { ...DEFAULT_LOCK_SCREEN, ...(lockScreen ?? {}) }

  return (
    <div className="space-y-4">
      <PersonalizationCard />
      <LockScreenCard
        settings={settings}
        gallery={gallery}
        onChange={(patch) => void setLockScreen(patch)}
      />
    </div>
  )
}
