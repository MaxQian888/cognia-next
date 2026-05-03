"use client"

import { useEffect, useRef } from "react"
import { useSettingsStore } from "@/stores/settings"
import { applyUserCss } from "@/lib/appearance/custom-css/apply"
import { disposeUrl, resolveSourceToCss } from "@/lib/appearance/wallpaper-storage"
import { withBuiltinPresets } from "@/lib/appearance/presets"
import type { BackgroundSettings, Wallpaper } from "@/types/appearance"

/** Body data attributes the appearance module owns. globals.css selectors key off these. */
const ATTR_ENABLED = "data-bg-enabled"
const ATTR_SCOPE = "data-bg-scope"

/** CSS variables the body::before pseudo-element reads. */
const VAR_IMAGE = "--app-bg-image"
const VAR_BLUR = "--app-bg-blur"
const VAR_OPACITY = "--app-bg-opacity"
const VAR_POSITION = "--app-bg-position"
const VAR_SIZE = "--app-bg-size"
const VAR_REPEAT = "--app-bg-repeat"

/**
 * Mounts at the root layout and keeps the document in sync with the user's
 * background + custom-CSS preferences. Renders nothing visible — its only
 * effect is on `<html>` / `<body>` attributes and CSS variables.
 *
 * Two effects:
 *   - background applier — watches `background` + `wallpapers` and updates
 *     `body[data-bg-enabled]`, `[data-bg-scope]` and the background CSS vars.
 *   - custom-CSS applier — pipes `customCss` + `customCssEnabled` to
 *     `applyUserCss`.
 *
 * Both are written so an outage in the background pipeline (e.g. a missing
 * IndexedDB blob) never blocks the custom-CSS one. Errors are logged but
 * do not throw — degrading to "no background" is the intended fallback.
 */
export function BackgroundApplier(): null {
  // Read flat-derived fields directly so a single store update only
  // re-renders this component when the appearance slice changes.
  const background = useSettingsStore((s) => s.background)
  const wallpapers = useSettingsStore((s) => s.wallpapers)
  const customCss = useSettingsStore((s) => s.customCss)
  const customCssEnabled = useSettingsStore((s) => s.customCssEnabled)

  const lastUrlRef = useRef<string | null>(null)

  useEffect(() => {
    if (typeof document === "undefined") return
    const body = document.body
    let cancelled = false

    void applyBackground({
      background,
      wallpapers,
      onApplied: (cssValue) => {
        // Revoke any prior Object URL we minted; only one is alive at a time.
        if (lastUrlRef.current) disposeUrl(lastUrlRef.current)
        lastUrlRef.current = cssValue
      },
      isCancelled: () => cancelled,
    }).catch((err) => {
      console.warn("BackgroundApplier failed", err)
      // On error fall back to "no background" rather than dangling on stale
      // CSS vars; the user can re-pick a wallpaper to retry.
      body.setAttribute(ATTR_ENABLED, "false")
    })

    return () => {
      cancelled = true
    }
  }, [background, wallpapers])

  useEffect(() => {
    applyUserCss(customCss, customCssEnabled)
  }, [customCss, customCssEnabled])

  return null
}

interface ApplyArgs {
  background: BackgroundSettings
  wallpapers: Wallpaper[]
  onApplied: (cssValue: string | null) => void
  isCancelled: () => boolean
}

async function applyBackground(args: ApplyArgs): Promise<void> {
  const { background, wallpapers, onApplied, isCancelled } = args
  const body = document.body
  if (!background.enabled || !background.activeId) {
    body.setAttribute(ATTR_ENABLED, "false")
    body.removeAttribute(ATTR_SCOPE)
    onApplied(null)
    return
  }

  const list = withBuiltinPresets(wallpapers)
  const wallpaper = list.find((w) => w.id === background.activeId)
  if (!wallpaper) {
    body.setAttribute(ATTR_ENABLED, "false")
    body.removeAttribute(ATTR_SCOPE)
    onApplied(null)
    return
  }

  const cssValue = await resolveSourceToCss(wallpaper.source)
  if (isCancelled()) {
    // The user changed wallpapers while we were resolving — drop our work.
    return
  }
  body.style.setProperty(VAR_IMAGE, cssValue)
  body.style.setProperty(VAR_BLUR, `${background.blurPx}px`)
  body.style.setProperty(VAR_OPACITY, `${background.opacity}`)
  // Image kinds need explicit sizing/positioning; gradients and colors
  // take the same vars but ignore them — we still write cover/no-repeat
  // for predictability.
  const isImageSource = wallpaper.source.kind === "image"
  body.style.setProperty(VAR_POSITION, "center")
  body.style.setProperty(
    VAR_SIZE,
    background.position === "tile"
      ? "auto"
      : background.position === "contain"
        ? "contain"
        : background.position === "center"
          ? "auto"
          : "cover"
  )
  body.style.setProperty(VAR_REPEAT, background.position === "tile" ? "repeat" : "no-repeat")
  body.setAttribute(ATTR_ENABLED, "true")
  body.setAttribute(ATTR_SCOPE, background.scope)
  // Tag whether the active source produces a real raster image so CSS can
  // omit `background-size: cover` for color/gradient sources (where it's
  // a no-op but causes confusion in devtools).
  body.setAttribute("data-bg-kind", isImageSource ? "image" : wallpaper.source.kind)
  onApplied(cssValue)
}

/** Exposed for tests. */
export const __INTERNALS__ = {
  ATTR_ENABLED,
  ATTR_SCOPE,
  VAR_IMAGE,
  VAR_BLUR,
  VAR_OPACITY,
  VAR_POSITION,
  VAR_SIZE,
  VAR_REPEAT,
}
