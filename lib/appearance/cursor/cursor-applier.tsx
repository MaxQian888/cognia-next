"use client"

// Mounts at the root layout and keeps `<style id="cognia-cursor">` in sync with
// `settings.cursor`.
//
// Paints in two passes on purpose:
//   1. synchronously with SVG data URLs, so the cursor changes on the same
//      frame the setting does (Chromium — the browser shell and the Windows /
//      Linux Tauri webviews — accepts these directly);
//   2. asynchronously with PNGs rasterized through a canvas, because WebKit
//      (the macOS Tauri webview and the iOS Capacitor shell) ignores SVG
//      cursors and would silently show the fallback keyword forever.
//
// The second pass is an upgrade, never a requirement: if canvas is unavailable
// the first pass stands, which is exactly right on the engines that need it.

import { useEffect } from "react"
import { useSettingsStore } from "@/stores/settings"
import { CURSOR_ROLE_CSS_KEYWORD, DEFAULT_CURSOR, type CursorSettings } from "@/types/appearance"
import { getCursorPack } from "./cursor-packs"
import { buildCursorCss, CURSOR_ROOT_ATTR, CURSOR_STYLE_ELEMENT_ID } from "./cursor-css"
import {
  cursorCssValue,
  cursorPixelSize,
  rasterizeCursorSvg,
  renderPackRoles,
  resolveCursorPalette,
} from "./render-cursor"
import { useCursorAccentColor } from "./use-cursor-accent"

/** Write (creating if needed) the singleton cursor stylesheet. */
function writeCursorStyle(css: string): void {
  let el = document.getElementById(CURSOR_STYLE_ELEMENT_ID) as HTMLStyleElement | null
  if (!el) {
    el = document.createElement("style")
    el.id = CURSOR_STYLE_ELEMENT_ID
    document.head.appendChild(el)
  }
  if (el.textContent !== css) el.textContent = css
}

/** Remove the stylesheet and the root attribute — back to the OS cursor. */
function clearCursorStyle(): void {
  document.getElementById(CURSOR_STYLE_ELEMENT_ID)?.remove()
  document.documentElement.removeAttribute(CURSOR_ROOT_ATTR)
}

/**
 * Resolve the settings row into everything the DOM needs, or `null` when the
 * OS cursor should be left alone. Pure — exported for tests.
 */
export function resolveCursorStyle(
  cursor: CursorSettings | undefined,
  accentColor: string | undefined
): { packId: string; css: string; svgs: { role: string; svg: string }[]; sizePx: number } | null {
  const merged: CursorSettings = { ...DEFAULT_CURSOR, ...(cursor ?? {}) }
  if (!merged.enabled) return null
  const pack = getCursorPack(merged.packId)
  if (!pack) return null

  const palette = resolveCursorPalette({
    pack,
    colorMode: merged.colorMode,
    customColor: merged.customColor,
    accentColor,
  })
  const sizePx = cursorPixelSize(merged.size)
  const rendered = renderPackRoles(pack, palette, sizePx, CURSOR_ROLE_CSS_KEYWORD)
  return {
    packId: pack.id,
    sizePx,
    svgs: rendered.map((r) => ({ role: r.role, svg: r.svg })),
    css: buildCursorCss(rendered.map((r) => ({ role: r.role, value: r.svgCss }))),
  }
}

export function CursorApplier(): null {
  const cursor = useSettingsStore((s) => s.settings?.cursor)
  const accentColor = useCursorAccentColor()

  useEffect(() => {
    if (typeof document === "undefined") return

    const merged: CursorSettings = { ...DEFAULT_CURSOR, ...(cursor ?? {}) }
    const pack = merged.enabled ? getCursorPack(merged.packId) : null
    if (!pack) {
      clearCursorStyle()
      return
    }

    const palette = resolveCursorPalette({
      pack,
      colorMode: merged.colorMode,
      customColor: merged.customColor,
      accentColor,
    })
    const sizePx = cursorPixelSize(merged.size)
    const rendered = renderPackRoles(pack, palette, sizePx, CURSOR_ROLE_CSS_KEYWORD)

    // Pass 1 — SVG, synchronous.
    writeCursorStyle(buildCursorCss(rendered.map((r) => ({ role: r.role, value: r.svgCss }))))
    document.documentElement.setAttribute(CURSOR_ROOT_ATTR, pack.id)

    // Pass 2 — PNG upgrade. `cancelled` guards a settings change that lands
    // while the decode is in flight, which would otherwise repaint the sheet
    // with the *previous* pack's art.
    let cancelled = false
    void (async () => {
      const upgraded = await Promise.all(
        rendered.map(async (r) => {
          const png = await rasterizeCursorSvg(r.svg, sizePx)
          return {
            role: r.role,
            value: png ? cursorCssValue(png, r.hotspot, CURSOR_ROLE_CSS_KEYWORD[r.role]) : r.svgCss,
          }
        })
      )
      if (cancelled) return
      if (!document.getElementById(CURSOR_STYLE_ELEMENT_ID)) return
      writeCursorStyle(buildCursorCss(upgraded))
    })()

    return () => {
      cancelled = true
      clearCursorStyle()
    }
  }, [cursor, accentColor])

  return null
}
