"use client"

import { useEffect } from "react"
import { useSettingsStore } from "@/stores/settings"
import { DEFAULT_DENSITY, type DensityLevel, type DensitySettings } from "@/types/appearance"
import { setDataAttr } from "./css-var"

/**
 * Resolve the data-attribute map this applier writes onto `<html>`.
 *
 * Layout:
 *   - `data-density` reflects the *global* level (drives `:root[data-density]`
 *     CSS variable selectors).
 *   - `data-density-chat` / `-table` / `-sidebar` are written only when the
 *     surface override differs from the global. The CSS selector
 *     `[data-surface][data-density-surface]` then takes effect when a
 *     surface container reads `data-surface="chat"` and the closest
 *     ancestor carries the matching override.
 *
 * Surface override semantics are intentionally additive: surfaces that don't
 * carry their own override inherit the global density via the cascade, so the
 * applier only writes attributes when they would change behavior. This keeps
 * the DOM clean and snapshot diffs minimal.
 *
 * Pure — exported for tests.
 */
export function resolveDensityAttrs(
  density: DensitySettings | undefined
): Record<string, string | null> {
  const d: DensitySettings = { ...DEFAULT_DENSITY, ...(density ?? {}) }
  const attrs: Record<string, string | null> = {
    "data-density": d.global,
  }
  // Per-surface overrides — only emit when they differ from the global.
  for (const [surface, attr] of [
    ["chat", "data-density-chat"],
    ["table", "data-density-table"],
    ["sidebar", "data-density-sidebar"],
  ] as const) {
    const v = d[surface]
    if (v && v !== d.global) {
      attrs[attr] = v
    } else {
      attrs[attr] = null
    }
  }
  return attrs
}

/** Per-surface override attribute keys that this applier owns. */
const SURFACE_ATTRS = ["data-density-chat", "data-density-table", "data-density-sidebar"] as const

/**
 * Mounts at the root layout. Reflects density settings onto `<html>` as
 * `data-density` (always) and per-surface override attributes (when present).
 */
export function DensityApplier(): null {
  const density = useSettingsStore((s) => s.settings?.density)

  useEffect(() => {
    if (typeof document === "undefined") return
    const root = document.documentElement
    const attrs = resolveDensityAttrs(density)
    setDataAttr(root, "data-density", attrs["data-density"] ?? null)
    for (const attr of SURFACE_ATTRS) {
      setDataAttr(root, attr, attrs[attr] ?? null)
    }
    return () => {
      // Cleanup wipes the global and any surface overrides we set.
      root.removeAttribute("data-density")
      for (const attr of SURFACE_ATTRS) root.removeAttribute(attr)
    }
  }, [density])

  return null
}

/**
 * Helper for surface containers to compute the `data-surface` value they
 * should render. Exported so chat/table/sidebar layouts stay in sync with
 * the attribute names this applier scans.
 */
export function densitySurfaceProps(
  surface: "chat" | "table" | "sidebar",
  density: DensitySettings | undefined
): { "data-surface": string; "data-density-surface"?: DensityLevel } {
  const d = { ...DEFAULT_DENSITY, ...(density ?? {}) }
  const override = d[surface]
  if (override && override !== d.global) {
    return { "data-surface": surface, "data-density-surface": override }
  }
  return { "data-surface": surface }
}
