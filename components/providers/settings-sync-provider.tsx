"use client"

import { useEffect } from "react"
import { useTheme } from "next-themes"
import { useSettingsStore } from "@/stores/settings-store"
import type { AppFontScale } from "@/lib/claude/types"

const FONT_SIZE_PX: Record<AppFontScale, number> = {
  xs: 14,
  sm: 15,
  md: 16,
  lg: 17,
  xl: 18,
}

/**
 * Mirrors the persisted appearance settings (theme / font scale / reduce
 * motion) to the live DOM. Mounted once near the root, inside next-themes'
 * ThemeProvider so it can hand the theme value off to `setTheme()`.
 *
 * `next-themes` already handles its own SSR/FOUC story via an inline script
 * and the system-theme media listener — we only re-apply our persisted choice
 * on first hydrate, so a user who already had `dark` selected doesn't flicker
 * to system on reload. Subsequent updates from the appearance section also
 * flow through this effect.
 */
export function SettingsSyncProvider({ children }: { children: React.ReactNode }) {
  const { setTheme } = useTheme()
  const settings = useSettingsStore((s) => s.settings)
  const loaded = useSettingsStore((s) => s.loaded)

  useEffect(() => {
    if (!loaded || !settings) return
    if (typeof document === "undefined") return

    const theme = settings.theme ?? "system"
    setTheme(theme)

    const scale = settings.fontScale ?? "md"
    const px = FONT_SIZE_PX[scale]
    document.documentElement.style.fontSize = `${px}px`

    if (settings.reduceMotion) {
      document.documentElement.setAttribute("data-reduce-motion", "true")
    } else {
      document.documentElement.removeAttribute("data-reduce-motion")
    }
  }, [loaded, settings?.theme, settings?.fontScale, settings?.reduceMotion, setTheme, settings])

  return <>{children}</>
}
