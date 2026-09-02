"use client"

import { useEffect, useRef } from "react"
import { useSettingsStore } from "@/stores/settings"
import { applyUserCss } from "@/lib/appearance/custom-css/apply"
import { disposeUrl, resolveSourceToCss } from "@/lib/appearance/wallpaper-storage"
import { BG_VARS, resolveBackgroundFit } from "@/lib/appearance/background-fit"
import {
  crossfadeToLayer,
  fadeToImage,
  normalizeToSingleLayer,
  rampDissolveBlur,
  writeTransitionTiming,
} from "@/lib/appearance/background-layers"
import { planTransition } from "@/lib/appearance/wallpaper-transition"
import { prefersReducedMotion } from "@/lib/appearance/reduced-motion"
import { DEFAULT_WALLPAPER_ROTATION } from "@/types/appearance/wallpaper-rotation"
import { withBuiltinPresets } from "@/lib/appearance/presets"
import { getPetWindowRole, isSecondaryOverlayRole } from "@/lib/pet/window-role"
import { useWallpaperRotation } from "@/hooks/appearance/use-wallpaper-rotation"
import type { BackgroundSettings, Wallpaper } from "@/types/appearance"

/** Body data attributes the appearance module owns. globals.css selectors key off these. */
const ATTR_ENABLED = "data-bg-enabled"
const ATTR_SCOPE = "data-bg-scope"
const ATTR_SCRIM = "data-bg-scrim"

/** CSS variables the body::before pseudo-element reads. */
const VAR_IMAGE = BG_VARS.image
const VAR_BLUR = BG_VARS.blur
const VAR_OPACITY = BG_VARS.opacity
const VAR_POSITION = BG_VARS.position
const VAR_SIZE = BG_VARS.size
const VAR_REPEAT = BG_VARS.repeat

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
  const customCssScope = useSettingsStore((s) => s.customCssScope)

  // The carousel timer. Lives here rather than in its own initializer so it
  // shares the single mount point the background already has.
  useWallpaperRotation()

  const lastUrlRef = useRef<string | null>(null)
  // Which wallpaper is currently painted. A change in this value between two
  // runs of the effect is what distinguishes "the user swapped wallpaper" from
  // "the user dragged the blur slider", and only the former animates.
  const paintedIdRef = useRef<string | null>(null)
  // Cancels the timers a fade or dissolve leaves behind. Advancing again while
  // one is pending must not let the old timer restore state belonging to a
  // wallpaper two swaps ago.
  const pendingRef = useRef<Array<() => void>>([])

  useEffect(() => {
    if (typeof document === "undefined") return
    const body = document.body
    let cancelled = false

    void applyBackground({
      background,
      wallpapers,
      previousId: paintedIdRef.current,
      cancelPending: () => {
        for (const cancel of pendingRef.current) cancel()
        pendingRef.current = []
      },
      registerPending: (cancel) => pendingRef.current.push(cancel),
      onApplied: (cssValue, paintedId) => {
        // Revoke any prior Object URL we minted; only one is alive at a time.
        if (lastUrlRef.current) disposeUrl(lastUrlRef.current)
        lastUrlRef.current = cssValue
        paintedIdRef.current = paintedId
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
    const pending = pendingRef
    return () => {
      for (const cancel of pending.current) cancel()
      pending.current = []
    }
  }, [])

  useEffect(() => {
    applyUserCss(customCss, customCssEnabled, customCssScope)
  }, [customCss, customCssEnabled, customCssScope])

  return null
}

interface ApplyArgs {
  background: BackgroundSettings
  wallpapers: Wallpaper[]
  /** The wallpaper id currently painted, or null on first run. */
  previousId: string | null
  /** Drop any timers a previous fade or dissolve left pending. */
  cancelPending: () => void
  /** Hand a canceller back to the component so unmount can drop it. */
  registerPending: (cancel: () => void) => void
  onApplied: (cssValue: string | null, paintedId: string | null) => void
  isCancelled: () => boolean
}

async function applyBackground(args: ApplyArgs): Promise<void> {
  const {
    background,
    wallpapers,
    previousId,
    cancelPending,
    registerPending,
    onApplied,
    isCancelled,
  } = args
  const body = document.body

  // The transparent desktop-pet windows (sprite overlay + click popup) load
  // this same root layout, so the wallpaper machinery would otherwise paint a
  // dimmed copy of the user's wallpaper into what must be a paint-through
  // window — via `body[data-bg-enabled]::before` AND the `#app[data-bg-target]`
  // layer for global/all scopes. Force wallpaper OFF in those windows: they own
  // no surface that should carry the app background.
  const role = getPetWindowRole()
  if (isSecondaryOverlayRole(role)) {
    disableBackground(body)
    onApplied(null, null)
    return
  }

  if (!background.enabled || !background.activeId) {
    disableBackground(body)
    onApplied(null, null)
    return
  }

  const list = withBuiltinPresets(wallpapers)
  const wallpaper = list.find((w) => w.id === background.activeId)
  if (!wallpaper) {
    // A deleted wallpaper that `activeId` still points at. Turning the layer
    // off is the honest outcome, and it is also what stops a rotation from
    // advancing onto a dead id and leaving a blank screen with no explanation.
    disableBackground(body)
    onApplied(null, null)
    return
  }

  const cssValue = await resolveSourceToCss(wallpaper.source)
  if (isCancelled()) {
    // The user changed wallpapers while we were resolving — drop our work.
    return
  }
  cancelPending()

  const isImageSource = wallpaper.source.kind === "image"
  const needsScrim = isImageSource && background.opacity < 0.5

  // The scrim and the second wallpaper layer both want `::after`. Resolve that
  // BEFORE choosing a transition, so `planTransition` is told the truth and
  // downgrades a crossfade to a fade rather than the two silently fighting.
  const rotation = { ...DEFAULT_WALLPAPER_ROTATION, ...(background.rotation ?? {}) }
  const plan = planTransition({
    rotation,
    scrimActive: needsScrim,
    reducedMotion: prefersReducedMotion(),
  })

  // Animate only a genuine wallpaper CHANGE. A blur-slider drag or a scope
  // switch re-runs this effect with the same image, and fading the wallpaper
  // out and back on every pointer move would be both ugly and expensive.
  const isSwap = previousId !== null && previousId !== background.activeId
  const animate = isSwap && rotation.enabled && plan.effective !== "none"

  body.style.setProperty(VAR_BLUR, `${background.blurPx}px`)
  body.style.setProperty(VAR_OPACITY, `${background.opacity}`)
  // Image kinds need explicit sizing/positioning; gradients and colors
  // take the same vars but ignore them — we still write the resolved fit
  // for predictability. `background-fit.ts` owns the mapping so the gallery
  // preview tile renders exactly what the live layer will.
  const fit = resolveBackgroundFit(background.position, background.focalX, background.focalY)
  body.style.setProperty(VAR_POSITION, fit.position)
  body.style.setProperty(VAR_SIZE, fit.size)
  body.style.setProperty(VAR_REPEAT, fit.repeat)
  body.setAttribute(ATTR_ENABLED, "true")
  body.setAttribute(ATTR_SCOPE, background.scope)
  // Tag whether the active source produces a real raster image so CSS can
  // omit `background-size: cover` for color/gradient sources (where it's
  // a no-op but causes confusion in devtools).
  body.setAttribute("data-bg-kind", isImageSource ? "image" : wallpaper.source.kind)

  if (!animate) {
    // Direct application. Fold any live two-layer stack back onto layer A
    // first, otherwise writing the image to layer A while phase says "b"
    // leaves the new wallpaper staged on a layer nobody is looking at.
    normalizeToSingleLayer(body)
    body.style.setProperty(VAR_IMAGE, cssValue)
  } else if (plan.twoLayer) {
    if (plan.effective === "dissolve") {
      registerPending(rampDissolveBlur({ body, plan, restoreBlurPx: background.blurPx }))
    }
    crossfadeToLayer({ body, cssValue, plan })
  } else {
    registerPending(fadeToImage({ body, cssValue, plan, opacity: background.opacity }))
  }

  if (!animate) writeTransitionTiming({ body, plan: { ...plan, durationMs: 0 } })

  // Text-protection scrim — only image wallpapers below 0.5 opacity need
  // the bottom-up gradient. Gradients and colors have honest opacity and
  // don't merit the extra layer.
  applyScrim(body, { needsScrim, scope: background.scope })

  onApplied(cssValue, background.activeId)
}

/**
 * Turn the wallpaper layer off and leave the stack in a state the next enable
 * can build on. Folding back to a single layer matters: re-enabling while the
 * phase still said "b" would paint into a `::after` that no longer exists.
 */
function disableBackground(body: HTMLElement): void {
  body.setAttribute(ATTR_ENABLED, "false")
  body.removeAttribute(ATTR_SCOPE)
  clearScrim(body)
  normalizeToSingleLayer(body)
}

/** Removes the scrim attribute from <body> and every scope target. */
function clearScrim(body: HTMLElement): void {
  body.removeAttribute(ATTR_SCRIM)
  document.querySelectorAll("[data-bg-target]").forEach((el) => {
    el.removeAttribute(ATTR_SCRIM)
  })
}

/**
 * Applies (or clears) the `data-bg-scrim` attribute on the appropriate
 * element(s) for the active scope. Always resets first so toggling
 * scope/opacity/kind cleanly migrates the attribute.
 */
function applyScrim(
  body: HTMLElement,
  args: { needsScrim: boolean; scope: BackgroundSettings["scope"] }
): void {
  clearScrim(body)
  if (!args.needsScrim) return
  if (args.scope === "all") {
    body.setAttribute(ATTR_SCRIM, "true")
    return
  }
  // scope=global matches any [data-bg-target] (mirrors the CSS rule);
  // chat / canvas / sidebar narrow to that exact target.
  const selector = args.scope === "global" ? "[data-bg-target]" : `[data-bg-target="${args.scope}"]`
  document.querySelectorAll(selector).forEach((el) => {
    el.setAttribute(ATTR_SCRIM, "true")
  })
}

/** Exposed for tests. */
export const __INTERNALS__ = {
  ATTR_ENABLED,
  ATTR_SCOPE,
  ATTR_SCRIM,
  VAR_IMAGE,
  VAR_BLUR,
  VAR_OPACITY,
  VAR_POSITION,
  VAR_SIZE,
  VAR_REPEAT,
}
