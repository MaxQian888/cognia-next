"use client"

import { useEffect, useState } from "react"
import { useTranslations } from "next-intl"

import { usePlatform } from "@/hooks/use-platform"
import { cn } from "@/lib/utils"

/**
 * Mobile boot splash overlay.
 *
 * The Android 12 system splash (`windowSplashScreenAnimatedIcon`) can only
 * show a *static* raster of the brand mark — it never animates and its
 * backdrop is a single flat colour. This web overlay takes over the instant
 * the native splash hands off (both paint the same `#01061e` backdrop, so the
 * transition is seamless) and renders the branded motion the native surface
 * can't: a circular logo wrapped in a slowly-rotating conic-gradient ring with
 * a breathing glow, then fades out.
 *
 * Dismissal is purely time-driven (`HOLD_MS` → fade → unmount), never gated on
 * async boot work — so a slow or failed sync can't strand the user on a frozen
 * splash. The rotation/glow keyframes collapse to a static frame under the
 * global reduce-motion guard in `app/globals.css`; the opacity fade is a
 * transition (not an animation) so the overlay always tears down cleanly.
 *
 * Mobile-only: `usePlatform()` returns `"web"` during SSR / static export and
 * in the browser + Tauri shells, where this renders `null`.
 */

/** Matches `@color/splash_background` + the native `windowSplashScreenBackground`. */
const SPLASH_BACKDROP = "#01061e"
/** Visible + animating before the fade-out begins. */
const HOLD_MS = 1500
/** Opacity fade-out duration; keep in sync with `.app-splash` transition. */
const FADE_MS = 450

type Phase = "visible" | "leaving" | "done"

export function AppSplash() {
  const platform = usePlatform()
  const t = useTranslations("mobile.splash")
  const [phase, setPhase] = useState<Phase>("visible")

  useEffect(() => {
    if (platform !== "mobile") return
    const fadeTimer = setTimeout(() => setPhase("leaving"), HOLD_MS)
    return () => clearTimeout(fadeTimer)
  }, [platform])

  useEffect(() => {
    if (phase !== "leaving") return
    const doneTimer = setTimeout(() => setPhase("done"), FADE_MS)
    return () => clearTimeout(doneTimer)
  }, [phase])

  if (platform !== "mobile" || phase === "done") return null

  return (
    <div
      role="status"
      aria-label={t("label")}
      data-state={phase}
      data-testid="app-splash"
      className={cn(
        "app-splash fixed inset-0 z-[9999] flex items-center justify-center",
        phase === "leaving" && "app-splash--leaving"
      )}
      style={{ backgroundColor: SPLASH_BACKDROP }}
    >
      <div className="relative flex size-44 items-center justify-center">
        <span aria-hidden="true" className="app-splash__glow absolute -inset-6 rounded-full" />
        <span aria-hidden="true" className="app-splash__ring absolute inset-0 rounded-full" />
        <span
          aria-hidden="true"
          className="app-splash__logo absolute inset-[8px] rounded-full bg-cover bg-center"
          style={{ backgroundImage: "url(/icons/icon-512.png)" }}
        />
      </div>
    </div>
  )
}
