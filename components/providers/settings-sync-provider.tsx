"use client"

import { useEffect, useRef } from "react"
import { useTheme } from "next-themes"
import { useSettingsStore } from "@/stores/settings"
import type { AppFontScale, AppTheme } from "@cognia/agent-config-types"
import { applyZoom, DEFAULT_ZOOM } from "@/lib/tauri/webview-zoom"
import { getPetWindowRole } from "@/lib/pet/window-role"

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
  // Flattened to scalars so the effect's deps cover exactly the four fields it
  // applies — keying on the whole `settings` object re-fired every write on
  // any unrelated save, and each re-fire ended in a Tauri `setZoom` IPC that
  // repaints the whole webview (the visible flicker after e.g. a theme save).
  const ready = loaded && settings !== null
  const theme = settings?.theme ?? "system"
  const fontScale = settings?.fontScale ?? "md"
  const reduceMotion = settings?.reduceMotion ?? false
  const webviewZoom = settings?.webviewZoom ?? DEFAULT_ZOOM
  // next-themes recreates `setTheme` on every theme flip (its useCallback keys
  // on the theme state), so it must NOT sit in this effect's deps: each flip
  // re-ran the effect and re-asserted the store's theme, which is still the
  // outgoing value while the matching save() is in flight — the DOM snapped
  // back to the old theme for a frame (the flicker), and every re-assert
  // recreated `setTheme` again, so each toggle fired the write twice. The ref
  // breaks the loop; the dedupe makes a stale echo write a no-op as well.
  const setThemeRef = useRef(setTheme)
  useEffect(() => {
    setThemeRef.current = setTheme
  })
  const lastTheme = useRef<AppTheme | null>(null)
  // `setZoom` re-asserted at the same factor still repaints the webview, so it
  // is guarded by the last applied value — a theme/font change re-runs this
  // effect without re-triggering the native repaint.
  const lastZoom = useRef<number | null>(null)

  useEffect(() => {
    if (!ready) return
    if (typeof document === "undefined") return

    if (theme !== lastTheme.current) {
      lastTheme.current = theme
      setThemeRef.current(theme)
    }

    const px = FONT_SIZE_PX[fontScale]
    document.documentElement.style.fontSize = `${px}px`

    if (reduceMotion) {
      document.documentElement.setAttribute("data-reduce-motion", "true")
    } else {
      document.documentElement.removeAttribute("data-reduce-motion")
    }

    // The webview zoom is the MAIN window's UI-scale preference. The
    // transparent pet overlay / popup windows load this same root layout, but
    // they own their own sizing (the sprite scales via `desktopPet.size`, not a
    // page zoom) and — being least-privilege — aren't granted
    // `core:webview:allow-set-webview-zoom` (see capabilities/pet.json). Calling
    // `setZoom` there both mis-scales the sprite and logs a denied-capability
    // error, so restrict the zoom sync to the main/web context.
    const role = getPetWindowRole()
    if ((role === "main" || role === "web") && lastZoom.current !== webviewZoom) {
      lastZoom.current = webviewZoom
      void applyZoom(webviewZoom)
    }
  }, [ready, theme, fontScale, reduceMotion, webviewZoom])

  return <>{children}</>
}
