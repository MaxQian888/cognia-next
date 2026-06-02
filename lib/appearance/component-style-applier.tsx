"use client"

import { useEffect } from "react"
import { useSettingsStore } from "@/stores/settings"
import type {
  ComponentElevation,
  ComponentStyleOverride,
  ComponentStyles,
  ComponentTonality,
} from "@/types/appearance"
import {
  COMPONENT_STYLE_REGISTRY,
  type ComponentPlacement,
  type ComponentStyleEntry,
} from "./component-style-registry"

const STYLE_ELEMENT_ID = "cognia-component-styles"

/** Box-shadow values mirror the `[data-elevation]` scale in globals.css. */
const ELEVATION_SHADOW: Record<Exclude<ComponentElevation, "default">, string> = {
  "0": "none",
  "1": "0 1px 2px 0 oklch(0 0 0 / 0.08)",
  "2": "0 4px 12px -2px oklch(0 0 0 / 0.12), 0 2px 4px -2px oklch(0 0 0 / 0.08)",
  "3": "0 12px 32px -4px oklch(0 0 0 / 0.18), 0 4px 12px -4px oklch(0 0 0 / 0.1)",
}

/** Tonality tier → the `--surface-tonality-*` token + matching blur tier. */
const TONALITY_TOKEN: Record<
  Exclude<ComponentTonality, "default" | "solid">,
  { tonalityVar: string; blurVar: string }
> = {
  translucent: {
    tonalityVar: "--surface-tonality-translucent",
    blurVar: "--surface-blur-subtle",
  },
  glass: { tonalityVar: "--surface-tonality-glass", blurVar: "--surface-blur-regular" },
  frosted: { tonalityVar: "--surface-tonality-frosted", blurVar: "--surface-blur-strong" },
}

const RADIUS_MIN = 0.5
const RADIUS_MAX = 2

function slotSel(slot: string): string {
  return `[data-slot="${slot}"]`
}

/**
 * Build the wallpaper-gated tonality selector for one slot. The compound
 * specificity is chosen to *equal* the auto wallpaper-aware rule in globals.css
 * for that placement, so this rule — injected later in `<head>` — wins on
 * source order. `inline` adds the `[data-bg-target]` descendant step; both
 * carry the bare `[data-bg-scope]` attribute so they match every scope.
 */
function tonalitySelector(slot: string, placement: ComponentPlacement, within?: string): string {
  const root = `body[data-bg-enabled="true"][data-bg-scope]`
  const tail = within ? `${within} ${slotSel(slot)}` : slotSel(slot)
  return placement === "inline" ? `${root} [data-bg-target] ${tail}` : `${root} ${tail}`
}

function tonalityDeclaration(
  tonality: Exclude<ComponentTonality, "default">,
  baseVar: string
): string {
  if (tonality === "solid") {
    return `background-color:var(${baseVar});backdrop-filter:none;-webkit-backdrop-filter:none;`
  }
  const { tonalityVar, blurVar } = TONALITY_TOKEN[tonality]
  return (
    `background-color:color-mix(in oklch,var(${baseVar}) var(${tonalityVar}),transparent);` +
    `backdrop-filter:blur(var(${blurVar}));-webkit-backdrop-filter:blur(var(${blurVar}));`
  )
}

/** Clamp the radius multiplier and trim to a stable, short decimal string. */
export function clampRadiusScale(scale: number): number {
  if (!Number.isFinite(scale)) return 1
  const clamped = scale < RADIUS_MIN ? RADIUS_MIN : scale > RADIUS_MAX ? RADIUS_MAX : scale
  return Math.round(clamped * 100) / 100
}

function entryRules(entry: ComponentStyleEntry, override: ComponentStyleOverride): string[] {
  const rules: string[] = []

  // 1. Tonality — wallpaper-gated, one compound rule across all slots.
  if (override.tonality && override.tonality !== "default") {
    const selector = entry.slots
      .map((slot) => tonalitySelector(slot, entry.placement, entry.within))
      .join(",")
    rules.push(`${selector}{${tonalityDeclaration(override.tonality, entry.baseVar)}}`)
  }

  // 2. Elevation + radius — wallpaper-independent. `body` prefix lifts the
  //    specificity just past the component's own Tailwind utility so the
  //    override wins by source order without `!important`.
  const decls: string[] = []
  if (override.elevation && override.elevation !== "default") {
    decls.push(`box-shadow:${ELEVATION_SHADOW[override.elevation]}`)
  }
  if (typeof override.radiusScale === "number" && override.radiusScale !== 1) {
    const scale = clampRadiusScale(override.radiusScale)
    if (scale !== 1) decls.push(`border-radius:calc(var(--radius) * ${scale})`)
  }
  if (decls.length > 0) {
    const within = entry.within ? `${entry.within} ` : ""
    const selector = entry.slots.map((slot) => `body ${within}${slotSel(slot)}`).join(",")
    rules.push(`${selector}{${decls.join(";")};}`)
  }

  return rules
}

/**
 * Project the per-component overrides into a CSS string. Pure — exported for
 * tests. Returns an empty string when nothing is customized so the applier can
 * drop the `<style>` tag entirely.
 */
export function resolveComponentStyleCss(styles: ComponentStyles | undefined): string {
  if (!styles) return ""
  const rules: string[] = []
  for (const entry of COMPONENT_STYLE_REGISTRY) {
    const override = styles[entry.key]
    if (!override) continue
    rules.push(...entryRules(entry, override))
  }
  return rules.join("\n")
}

/**
 * Idempotent — create / update / remove the singleton `<style>` tag carrying
 * the generated component-style CSS. Mirrors `applyUserCss`. Appended at the
 * end of `<head>` so its rules win against the framework stylesheet.
 */
export function applyComponentStyleCss(css: string): void {
  if (typeof document === "undefined") return
  const existing = document.getElementById(STYLE_ELEMENT_ID) as HTMLStyleElement | null
  if (css.trim().length === 0) {
    if (existing) existing.remove()
    return
  }
  let tag = existing
  if (!tag) {
    tag = document.createElement("style")
    tag.id = STYLE_ELEMENT_ID
    document.head.appendChild(tag)
  }
  if (tag.textContent !== css) tag.textContent = css
}

/**
 * Mounts at the root layout. Keeps the injected component-style sheet in sync
 * with `settings.componentStyles`. Renders nothing.
 */
export function ComponentStyleApplier(): null {
  const componentStyles = useSettingsStore((s) => s.settings?.componentStyles)

  useEffect(() => {
    applyComponentStyleCss(resolveComponentStyleCss(componentStyles))
    return () => applyComponentStyleCss("")
  }, [componentStyles])

  return null
}

/** Exposed for tests. */
export const __INTERNALS__ = { STYLE_ELEMENT_ID, ELEVATION_SHADOW, TONALITY_TOKEN }
