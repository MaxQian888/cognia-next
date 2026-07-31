"use client"

import { useEffect, useSyncExternalStore } from "react"
import { useSettingsStore } from "@/stores/settings"
import {
  listPluginThemes,
  subscribeThemeRegistry,
  type PluginTheme,
} from "@/lib/theme/theme-registry"

/**
 * Applies a directly-activated plugin theme (`settings.activePluginThemeId`)
 * as a scoped `<style data-plugin-theme="<pluginId>">:root{…}</style>` block
 * in `<head>` — the runtime consumer that ADR-0026 §3 §D promised but never
 * shipped. Before this, a plugin's `cssVariables` theme was sanitized,
 * registered, and cloned, yet its variables never reached the DOM.
 *
 * Coordination with `CustomThemeApplier`: the two active pointers
 * (`activeCustomThemeId` / `activePluginThemeId`) are mutually exclusive in
 * the settings store, and `CustomThemeApplier` clears its inline `<html>`
 * vars whenever a plugin theme is active — otherwise an inline custom
 * property would out-specify this stylesheet block. So exactly one of the two
 * appliers paints at a time: this one owns the `<style>` block; the other
 * owns inline `<html>` vars.
 *
 * Graceful fallback: if the active plugin theme is missing from the registry
 * (its owning plugin was disabled or uninstalled), the block is removed and
 * `activePluginThemeId` is reset to null so the preset / custom theme resumes.
 */

const STYLE_ELEMENT_ID = "cognia-plugin-theme"

// Stable empty snapshot for SSR / pre-registration renders — same rationale
// as the theme tab's registry subscription.
const EMPTY_PLUGIN_THEMES: PluginTheme[] = []
function getServerPluginThemes(): PluginTheme[] {
  return EMPTY_PLUGIN_THEMES
}

/**
 * Serialize a CSS-variable map into a `:root{…}` rule. Defensive: only
 * `--*` names and values free of characters that could break out of the
 * declaration block are emitted. The themes-bridge already sanitizes
 * plugin-supplied values, so this is belt-and-suspenders.
 */
export function serializePluginThemeCss(vars: Record<string, string>): string {
  const decls: string[] = []
  for (const [name, value] of Object.entries(vars)) {
    if (!name.startsWith("--")) continue
    if (typeof value !== "string" || value.length === 0) continue
    if (/[<>{};]/.test(value)) continue
    decls.push(`${name}: ${value};`)
  }
  return `:root{${decls.join(" ")}}`
}

export function PluginThemeApplier(): null {
  const activePluginThemeId = useSettingsStore((s) => s.activePluginThemeId)
  const setActivePluginTheme = useSettingsStore((s) => s.setActivePluginTheme)
  const pluginThemes = useSyncExternalStore(
    subscribeThemeRegistry,
    listPluginThemes,
    getServerPluginThemes
  )

  useEffect(() => {
    if (typeof document === "undefined") return
    const existing = document.getElementById(STYLE_ELEMENT_ID)

    if (!activePluginThemeId) {
      existing?.remove()
      return
    }

    const theme = pluginThemes.find((t) => t.id === activePluginThemeId)
    if (!theme) {
      existing?.remove()
      // Owning plugin gone — reset so the preset/custom theme takes over.
      setActivePluginTheme(null)
      return
    }

    // `variables` already carries the full map (raw cssVars for CSS-var
    // themes, colorsToVariables(colors) for structured ones); merge cssVars
    // to be certain every declared override lands.
    const vars = { ...theme.variables, ...(theme.cssVars ?? {}) }
    const css = serializePluginThemeCss(vars)

    const el = existing ?? document.createElement("style")
    if (!existing) {
      el.id = STYLE_ELEMENT_ID
      document.head.appendChild(el)
    }
    el.setAttribute("data-plugin-theme", theme.pluginId ?? "")
    el.setAttribute("data-theme-id", theme.id)
    if (el.textContent !== css) el.textContent = css
  }, [activePluginThemeId, pluginThemes, setActivePluginTheme])

  // Remove the block on unmount (e.g. app teardown) so a stale theme never
  // outlives the applier.
  useEffect(() => {
    return () => {
      if (typeof document === "undefined") return
      document.getElementById(STYLE_ELEMENT_ID)?.remove()
    }
  }, [])

  return null
}
